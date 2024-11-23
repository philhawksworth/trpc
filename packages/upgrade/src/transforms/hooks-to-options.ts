/* eslint-disable no-console */
import type {
  API,
  ArrowFunctionExpression,
  ASTPath,
  CallExpression,
  FileInfo,
  FunctionDeclaration,
  Identifier,
  MemberExpression,
  Options,
} from 'jscodeshift';

interface TransformOptions extends Options {
  trpcFile?: string;
  trpcImportName?: string;
}

const hookToOptions = {
  useQuery: { lib: '@tanstack/react-query', fn: 'queryOptions' },
  useSuspenseQuery: { lib: '@tanstack/react-query', fn: 'queryOptions' },
  useInfiniteQuery: {
    lib: '@tanstack/react-query',
    fn: 'infiniteQueryOptions',
  },
  useSuspenseInfiniteQuery: {
    lib: '@tanstack/react-query',
    fn: 'infiniteQueryOptions',
  },
  useMutation: { lib: '@tanstack/react-query', fn: 'mutationOptions' },
  useSubscription: {
    lib: '@trpc/tanstack-react-query',
    fn: 'subscriptionOptions',
  },
} as const;

const utilMap = {
  fetch: 'fetchQuery',
  fetchInfinite: 'fetchInfiniteQuery',
  prefetch: 'prefetchQuery',
  prefetchInfinite: 'prefetchInfiniteQuery',
  ensureData: 'ensureQueryData',
  invalidate: 'invalidateQueries',
  reset: 'resetQueries',
  refetch: 'refetchQueries',
  cancel: 'cancelQuery',
  setData: 'setQueryData',
  setQueriesData: 'setQueriesData',
  setInfiniteData: 'setInfiniteQueryData',
  getData: 'getQueryData',
  getInfiniteData: 'getInfiniteQueryData',
  // setMutationDefaults: 'setMutationDefaults',
  // getMutationDefaults: 'getMutationDefaults',
  // isMutating: 'isMutating',
} as const;
type ProxyMethod = keyof typeof utilMap;

export default function transform(
  file: FileInfo,
  api: API,
  options: TransformOptions,
) {
  const { trpcFile, trpcImportName } = options;
  if (!trpcFile || !trpcImportName) {
    throw new Error('trpcFile and trpcImportName are required');
  }

  const j = api.jscodeshift;
  const root = j(file.source);
  let dirtyFlag = false;

  // Traverse all functions, and _do stuff_
  root.find(j.FunctionDeclaration).forEach((path) => {
    if (j(path).find(j.Identifier, { name: trpcImportName }).size() > 0) {
      updateTRPCImport(path);
    }

    replaceHooksWithOptions(path);
    removeSuspenseDestructuring(path);
    migrateUseUtils(path);
  });
  root.find(j.ArrowFunctionExpression).forEach((path) => {
    if (j(path).find(j.Identifier, { name: trpcImportName }).size() > 0) {
      updateTRPCImport(path);
    }

    replaceHooksWithOptions(path);
    removeSuspenseDestructuring(path);
    migrateUseUtils(path);
  });

  /**
   * === HELPER FUNCTIONS BELOW ===
   */

  function updateTRPCImport(
    path: ASTPath<FunctionDeclaration | ArrowFunctionExpression>,
  ) {
    const specifier = root
      .find(j.ImportDeclaration, {
        source: { value: trpcFile },
      })
      .find(j.ImportSpecifier, { imported: { name: trpcImportName } });

    if (specifier.size() === 0) {
      return;
    }

    specifier.replaceWith(j.importSpecifier(j.identifier('useTRPC')));
    dirtyFlag = true;

    const variableDeclaration = j.variableDeclaration('const', [
      j.variableDeclarator(
        j.identifier(trpcImportName),
        j.callExpression(j.identifier('useTRPC'), []),
      ),
    ]);

    if (j.FunctionDeclaration.check(path.node)) {
      const body = path.node.body.body;
      body.unshift(variableDeclaration);
    } else if (j.BlockStatement.check(path.node.body)) {
      path.node.body.body.unshift(variableDeclaration);
    }
  }

  function ensureImported(lib: string, specifier: string) {
    if (
      root
        .find(j.ImportDeclaration, {
          source: { value: lib },
        })
        .find(j.ImportSpecifier, { imported: { name: specifier } })
        .size() === 0
    ) {
      root
        .find(j.ImportDeclaration)
        .at(-1)
        .insertAfter(
          j.importDeclaration(
            [j.importSpecifier(j.identifier(specifier))],
            j.literal(lib),
          ),
        );
      dirtyFlag = true;
    }
  }

  function replaceHooksWithOptions(
    path: ASTPath<FunctionDeclaration | ArrowFunctionExpression>,
  ) {
    // REplace proxy-hooks with useX(options())
    for (const [hook, { fn, lib }] of Object.entries(hookToOptions)) {
      j(path)
        .find(j.CallExpression, {
          callee: {
            property: { name: hook },
          },
        })
        .forEach((path) => {
          const memberExpr = path.node.callee;
          memberExpr.property.name = fn;

          const useQueryFunction = j.callExpression(j.identifier(hook), [
            path.node,
          ]);
          j(path).replaceWith(useQueryFunction);

          ensureImported(lib, hook);
          dirtyFlag = true;
        });
    }
  }

  // Migrate trpc.useUtils() to useQueryClient()
  function migrateUseUtils(
    path: ASTPath<FunctionDeclaration | ArrowFunctionExpression>,
  ) {
    j(path)
      .find(j.CallExpression, {
        callee: {
          property: {
            name: (name: string) => ['useContext', 'useUtils'].includes(name),
          },
        },
      })
      .forEach((path) => {
        if (
          j.VariableDeclarator.check(path.parentPath.node) &&
          j.Identifier.check(path.parentPath.node.id)
        ) {
          const oldIdentifier = path.parentPath.node.id as Identifier;

          // Find all the references to `utils` and replace with `queryClient[helperMap](trpc.PATH.queryFilter())`
          root
            .find(j.Identifier, { name: oldIdentifier.name })
            .forEach((path) => {
              if (j.MemberExpression.check(path.parent?.parent?.node)) {
                const callExprPath = path.parent.parent.parent;
                const callExpr = callExprPath.node as CallExpression;
                const memberExpr = callExpr.callee as MemberExpression;
                if (
                  !j.CallExpression.check(callExpr) ||
                  !j.MemberExpression.check(memberExpr)
                ) {
                  console.warn(
                    'Failed to walk up the tree to find utilMethod call expression',
                    callExpr,
                  );
                  return;
                }

                if (
                  !(
                    j.MemberExpression.check(memberExpr.object) &&
                    j.Identifier.check(memberExpr.object.object) &&
                    j.Identifier.check(memberExpr.property) &&
                    memberExpr.property.name in utilMap
                  )
                ) {
                  console.warn(
                    'Failed to identify utilMethod from proxy call expression',
                    memberExpr,
                  );
                  return;
                }

                // Replace util.PATH.proxyMethod() with trpc.PATH.queryFilter()
                const proxyMethod = memberExpr.property.name as ProxyMethod;
                memberExpr.object.object = j.identifier('trpc');
                memberExpr.property = j.identifier('queryFilter');

                // Wrap it in queryClient.utilMethod()
                j(callExprPath).replaceWith(
                  j.memberExpression(
                    j.identifier('queryClient'),
                    j.callExpression(j.identifier(utilMap[proxyMethod]), [
                      callExpr,
                    ]),
                  ),
                );
              }
            });

          // Replace `const utils = trpc.useUtils()` with `const queryClient = useQueryClient()`
          j(path).replaceWith(
            j.callExpression(j.identifier('useQueryClient'), []),
          );
          path.parentPath.node.id = j.identifier('queryClient');
          ensureImported('@tanstack/react-query', 'useQueryClient');
        }

        dirtyFlag = true;
      });
  }

  function removeSuspenseDestructuring(
    path: ASTPath<FunctionDeclaration | ArrowFunctionExpression>,
  ) {
    // Remove suspense query destructuring
    j(path)
      .find(j.VariableDeclaration)
      .forEach((path) => {
        const declarator = j.VariableDeclarator.check(path.node.declarations[0])
          ? path.node.declarations[0]
          : null;

        if (
          !j.CallExpression.check(declarator?.init) ||
          !j.Identifier.check(declarator.init.callee) ||
          (declarator.init.callee.name !== 'useSuspenseQuery' &&
            declarator.init.callee.name !== 'useSuspenseInfiniteQuery')
        ) {
          return;
        }

        const tuple = j.ArrayPattern.check(declarator?.id)
          ? declarator.id
          : null;
        const dataName = j.Identifier.check(tuple?.elements?.[0])
          ? tuple.elements[0].name
          : null;
        const queryName = j.Identifier.check(tuple?.elements?.[1])
          ? tuple.elements[1].name
          : null;

        if (declarator && dataName && queryName) {
          declarator.id = j.identifier(queryName);
          j(path).insertAfter(
            j.variableDeclaration('const', [
              j.variableDeclarator(
                j.identifier(dataName),
                j.memberExpression(
                  j.identifier(queryName),
                  j.identifier('data'),
                ),
              ),
            ]),
          );
          dirtyFlag = true;
        }
      });
  }

  return dirtyFlag ? root.toSource() : undefined;
}

export const parser = 'tsx';

// https://go.codemod.com/ddX54TM
