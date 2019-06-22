// @flow

import { declare } from "@babel/helper-plugin-utils";
import { types as t, template } from "@babel/core";
import * as traverse from "@babel/traverse";
import type { NodePath } from "@babel/traverse";

import getTargets from "@babel/preset-env/lib/targets-parser";
import filterItems, {
  isPluginRequired,
} from "@babel/preset-env/lib/filter-items";

import {
  getImportSource,
  getRequireSource,
  resolveKey,
  resolveSource,
} from "./utils";
import { createProviderDescriptors } from "./config";

export { resolveProvider } from "./config";
import ImportsCache from "./imports-cache";

import type {
  ProviderApi,
  Utils,
  Options,
  Targets,
  MetaDescriptor,
  PolyfillProvider,
} from "./types";

export type { PolyfillProvider, MetaDescriptor };

export default declare((api, options: Options, dirname: string) => {
  api.assertVersion(7);

  const {
    method,
    providers,
    targets: targetsOption,
    ignoreBrowserslistConfig,
    configPath,
  } = options;

  let methodName;
  if (method === "usage-global") methodName = "usageGlobal";
  else if (method === "entry-global") methodName = "entryGlobal";
  else if (method === "usage-pure") methodName = "usagePure";
  else if (typeof method !== "string") {
    throw new Error(".method must be a string");
  } else {
    throw new Error(
      `.method must be one of "entry-global", "usage-global"` +
        ` or "usage-pure" (received "${method}")`,
    );
  }

  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error(".providers must be an array with at least one element.");
  }

  const targets: Targets = getTargets(targetsOption, {
    ignoreBrowserslistConfig,
    configPath,
  });

  const providersDescriptors = createProviderDescriptors(providers, dirname);

  const resolvedProviders = providersDescriptors.map(
    ({ value, options = {}, alias }) => {
      const include = new Set(options.include || []);
      const exclude = new Set(options.exclude || []);

      const api: ProviderApi = {
        getUtils,
        method,
        targets,
        include,
        exclude,
        filterPolyfills(polyfills, defaultInclude, defaultExclude) {
          return filterItems(
            polyfills,
            include,
            exclude,
            targets,
            defaultInclude,
            defaultExclude,
          );
        },
        isPolyfillRequired(support) {
          return isPluginRequired(targets, support);
        },
      };

      const provider = value(api, options);

      if (typeof provider[methodName] !== "function") {
        throw new Error(
          `The "${provider.name || alias}" provider doesn't ` +
            `support the "${method}" polyfilling method.`,
        );
      }

      return provider;
    },
  );

  const cache = new ImportsCache();

  function hoist(node) {
    node._blockHoist = 3;
    return node;
  }

  function getUtils(path: NodePath): Utils {
    const programPath = path.findParent(p => p.isProgram());

    return {
      injectGlobalImport(url) {
        cache.store(programPath, url, "", (isScript, source) => ({
          node: isScript
            ? template.statement.ast`require(${source})`
            : t.importDeclaration([], source),
          name: "",
        }));
      },
      injectNamedImport(url, name, hint = name) {
        return cache.store(programPath, url, name, (isScript, source, name) => {
          const id = programPath.scope.generateUidIdentifier(hint);
          return {
            node: isScript
              ? hoist(template.statement.ast`
                  var ${id} = require(${source}).${name}
                `)
              : t.importDeclaration([t.importSpecifier(id, name)], source),
            name: id.name,
          };
        });
      },
      injectDefaultImport(url, hint = url) {
        return cache.store(programPath, url, "default", (isScript, source) => {
          const id = programPath.scope.generateUidIdentifier(hint);
          return {
            node: isScript
              ? hoist(template.statement.ast`var ${id} = require(${source})`)
              : t.importDeclaration([t.importDefaultSpecifier(id)], source),
            name: id.name,
          };
        });
      },
    };
  }

  function callProviders(payload: MetaDescriptor, path: NodePath) {
    const utils = getUtils(path);

    resolvedProviders.every(provider => {
      // $FlowIgnore
      provider[methodName](payload, utils, path);
      return !!path.node;
    });
  }

  function property(object, key, placement, path) {
    return callProviders({ kind: "property", object, key, placement }, path);
  }

  const entryVisitor = {
    ImportDeclaration(path) {
      const source = getImportSource(path);
      if (!source) return;
      callProviders({ kind: "import", source }, path);
    },
    Program(path: NodePath) {
      path.get("body").forEach(bodyPath => {
        const source = getRequireSource(bodyPath);
        if (!source) return;
        callProviders({ kind: "import", source }, bodyPath);
      });
    },
  };

  const usageVisitor = {
    // Symbol(), new Promise
    ReferencedIdentifier(path: NodePath) {
      const {
        node: { name },
        scope,
      } = path;
      if (scope.getBindingIdentifier(name)) return;

      callProviders({ kind: "global", name }, path);
    },

    MemberExpression(path: NodePath) {
      const key = resolveKey(path.get("property"), path.node.computed);
      if (!key || key === "prototype") return;

      const source = resolveSource(path.get("object"));
      return property(source.id, key, source.placement, path);
    },

    ObjectPattern(path: NodePath) {
      const { parentPath, parent } = path;
      let obj;

      // const { keys, values } = Object
      if (parentPath.isVariableDeclarator()) {
        obj = parentPath.get("init");
        // ({ keys, values } = Object)
      } else if (parentPath.isAssignmentExpression()) {
        obj = parentPath.get("right");
        // !function ({ keys, values }) {...} (Object)
        // resolution does not work after properties transform :-(
      } else if (parentPath.isFunction()) {
        const grand = parentPath.parentPath;
        if (grand.isCallExpression() || grand.isNewExpression()) {
          if (grand.node.callee === parent) {
            obj = grand.get("arguments")[path.key];
          }
        }
      }

      let id = null;
      let placement = null;
      if (obj) ({ id, placement } = resolveSource(obj));

      for (const prop of path.get("properties")) {
        if (prop.isObjectProperty()) {
          const key = resolveKey(prop.get("key"));
          if (key) property(id, key, placement, prop);
        }
      }
    },

    BinaryExpression(path: NodePath) {
      if (path.node.operator !== "in") return;

      const source = resolveSource(path.get("right"));
      const key = resolveKey(path.get("left"), true);

      if (!key) return;

      callProviders(
        {
          kind: "in",
          object: source.id,
          key,
          placement: source.placement,
        },
        path,
      );
    },
  };

  const visitors = [method === "entry-global" ? entryVisitor : usageVisitor];
  resolvedProviders.forEach(p => p.visitor && visitors.push(p.visitor));

  return {
    name: "inject-polyfills",
    visitor: traverse.visitors.merge(visitors),
  };
});
