'use strict';

const {
  ArrayIsArray,
  ArrayPrototypeJoin,
  ArrayPrototypeShift,
  JSONStringify,
  ObjectGetOwnPropertyNames,
  ObjectPrototypeHasOwnProperty,
  RegExp,
  RegExpPrototypeExec,
  RegExpPrototypeSymbolReplace,
  SafeMap,
  SafeSet,
  String,
  StringPrototypeEndsWith,
  StringPrototypeIncludes,
  StringPrototypeIndexOf,
  StringPrototypeLastIndexOf,
  StringPrototypeReplace,
  StringPrototypeSlice,
  StringPrototypeSplit,
  StringPrototypeStartsWith,
} = primordials;
const internalFS = require('internal/fs/utils');
const { BuiltinModule } = require('internal/bootstrap/realm');
const { realpathSync } = require('fs');
const { getOptionValue } = require('internal/options');
// Do not eagerly grab .manifest, it may be in TDZ
const policy = getOptionValue('--experimental-policy') ?
  require('internal/process/policy') :
  null;
const { sep, relative, toNamespacedPath, resolve } = require('path');
const preserveSymlinks = getOptionValue('--preserve-symlinks');
const preserveSymlinksMain = getOptionValue('--preserve-symlinks-main');
const experimentalNetworkImports =
  getOptionValue('--experimental-network-imports');
const typeFlag = getOptionValue('--input-type');
const { URL, pathToFileURL, fileURLToPath, isURL } = require('internal/url');
const { canParse: URLCanParse } = internalBinding('url');
const { legacyMainResolve: FSLegacyMainResolve } = internalBinding('fs');
const {
  ERR_INPUT_TYPE_NOT_ALLOWED,
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_MODULE_SPECIFIER,
  ERR_INVALID_PACKAGE_CONFIG,
  ERR_INVALID_PACKAGE_TARGET,
  ERR_MANIFEST_DEPENDENCY_MISSING,
  ERR_MODULE_NOT_FOUND,
  ERR_PACKAGE_IMPORT_NOT_DEFINED,
  ERR_PACKAGE_PATH_NOT_EXPORTED,
  ERR_UNSUPPORTED_DIR_IMPORT,
  ERR_NETWORK_IMPORT_DISALLOWED,
} = require('internal/errors').codes;

const { Module: CJSModule } = require('internal/modules/cjs/loader');
const { getPackageScopeConfig } = require('internal/modules/esm/package_config');
const { getConditionsSet } = require('internal/modules/esm/utils');
const packageJsonReader = require('internal/modules/package_json_reader');
const { internalModuleStat } = internalBinding('fs');

/**
 * @typedef {import('internal/modules/esm/package_config.js').PackageConfig} PackageConfig
 */


const emittedPackageWarnings = new SafeSet();

function emitTrailingSlashPatternDeprecation(match, pjsonUrl, base) {
  const pjsonPath = fileURLToPath(pjsonUrl);
  if (emittedPackageWarnings.has(pjsonPath + '|' + match))
    return;
  emittedPackageWarnings.add(pjsonPath + '|' + match);
  process.emitWarning(
    `Use of deprecated trailing slash pattern mapping "${match}" in the ` +
    `"exports" field module resolution of the package at ${pjsonPath}${
      base ? ` imported from ${fileURLToPath(base)}` :
        ''}. Mapping specifiers ending in "/" is no longer supported.`,
    'DeprecationWarning',
    'DEP0155',
  );
}

const doubleSlashRegEx = /[/\\][/\\]/;

function emitInvalidSegmentDeprecation(target, request, match, pjsonUrl, internal, base, isTarget) {
  const pjsonPath = fileURLToPath(pjsonUrl);
  const double = RegExpPrototypeExec(doubleSlashRegEx, isTarget ? target : request) !== null;
  process.emitWarning(
    `Use of deprecated ${double ? 'double slash' :
      'leading or trailing slash matching'} resolving "${target}" for module ` +
      `request "${request}" ${request !== match ? `matched to "${match}" ` : ''
      }in the "${internal ? 'imports' : 'exports'}" field module resolution of the package at ${
        pjsonPath}${base ? ` imported from ${fileURLToPath(base)}` : ''}.`,
    'DeprecationWarning',
    'DEP0166',
  );
}

/**
 * @param {URL} url
 * @param {URL} packageJSONUrl
 * @param {string | URL | undefined} base
 * @param {string} [main]
 * @returns {void}
 */
function emitLegacyIndexDeprecation(url, packageJSONUrl, base, main) {
  const format = defaultGetFormatWithoutErrors(url);
  if (format !== 'module')
    return;
  const path = fileURLToPath(url);
  const pkgPath = fileURLToPath(new URL('.', packageJSONUrl));
  const basePath = fileURLToPath(base);
  if (!main) {
    process.emitWarning(
      `No "main" or "exports" field defined in the package.json for ${pkgPath
      } resolving the main entry point "${
        StringPrototypeSlice(path, pkgPath.length)}", imported from ${basePath
      }.\nDefault "index" lookups for the main are deprecated for ES modules.`,
      'DeprecationWarning',
      'DEP0151',
    );
  } else if (resolve(pkgPath, main) !== path) {
    process.emitWarning(
      `Package ${pkgPath} has a "main" field set to "${main}", ` +
      `excluding the full filename and extension to the resolved file at "${
        StringPrototypeSlice(path, pkgPath.length)}", imported from ${
        basePath}.\n Automatic extension resolution of the "main" field is ` +
      'deprecated for ES modules.',
      'DeprecationWarning',
      'DEP0151',
    );
  }
}

const realpathCache = new SafeMap();

const legacyMainResolveExtensions = [
  '',
  '.js',
  '.json',
  '.node',
  '/index.js',
  '/index.json',
  '/index.node',
  './index.js',
  './index.json',
  './index.node',
];

const legacyMainResolveExtensionsIndexes = {
  // 0-6: when packageConfig.main is defined
  kResolvedByMain: 0,
  kResolvedByMainJs: 1,
  kResolvedByMainJson: 2,
  kResolvedByMainNode: 3,
  kResolvedByMainIndexJs: 4,
  kResolvedByMainIndexJson: 5,
  kResolvedByMainIndexNode: 6,
  // 7-9: when packageConfig.main is NOT defined,
  //      or when the previous case didn't found the file
  kResolvedByPackageAndJs: 7,
  kResolvedByPackageAndJson: 8,
  kResolvedByPackageAndNode: 9,
};

/**
 * Legacy CommonJS main resolution:
 * 1. let M = pkg_url + (json main field)
 * 2. TRY(M, M.js, M.json, M.node)
 * 3. TRY(M/index.js, M/index.json, M/index.node)
 * 4. TRY(pkg_url/index.js, pkg_url/index.json, pkg_url/index.node)
 * 5. NOT_FOUND
 * @param {URL} packageJSONUrl
 * @param {PackageConfig} packageConfig
 * @param {string | URL | undefined} base
 * @returns {URL}
 */
function legacyMainResolve(packageJSONUrl, packageConfig, base) {
  const packageJsonUrlString = packageJSONUrl.href;

  if (typeof packageJsonUrlString !== 'string') {
    throw new ERR_INVALID_ARG_TYPE('packageJSONUrl', ['URL'], packageJSONUrl);
  }

  const baseStringified = isURL(base) ? base.href : base;

  const resolvedOption = FSLegacyMainResolve(packageJsonUrlString, packageConfig.main, baseStringified);

  const baseUrl = resolvedOption <= legacyMainResolveExtensionsIndexes.kResolvedByMainIndexNode ? `./${packageConfig.main}` : '';
  const resolvedUrl = new URL(baseUrl + legacyMainResolveExtensions[resolvedOption], packageJSONUrl);

  emitLegacyIndexDeprecation(resolvedUrl, packageJSONUrl, base, packageConfig.main);

  return resolvedUrl;
}

const encodedSepRegEx = /%2F|%5C/i;
/**
 * @param {URL} resolved
 * @param {string | URL | undefined} base
 * @param {boolean} preserveSymlinks
 * @returns {URL | undefined}
 */
function finalizeResolution(resolved, base, preserveSymlinks) {
  if (RegExpPrototypeExec(encodedSepRegEx, resolved.pathname) !== null)
    throw new ERR_INVALID_MODULE_SPECIFIER(
      resolved.pathname, 'must not include encoded "/" or "\\" characters',
      fileURLToPath(base));

  const path = fileURLToPath(resolved);

  const stats = internalModuleStat(toNamespacedPath(StringPrototypeEndsWith(path, '/') ?
    StringPrototypeSlice(path, -1) : path));

  // Check for stats.isDirectory()
  if (stats === 1) {
    throw new ERR_UNSUPPORTED_DIR_IMPORT(path, fileURLToPath(base), String(resolved));
  } else if (stats !== 0) {
    // Check for !stats.isFile()
    if (process.env.WATCH_REPORT_DEPENDENCIES && process.send) {
      process.send({ 'watch:require': [path || resolved.pathname] });
    }
    throw new ERR_MODULE_NOT_FOUND(
      path || resolved.pathname, base && fileURLToPath(base), 'module');
  }

  if (!preserveSymlinks) {
    const real = realpathSync(path, {
      [internalFS.realpathCacheKey]: realpathCache,
    });
    const { search, hash } = resolved;
    resolved =
        pathToFileURL(real + (StringPrototypeEndsWith(path, sep) ? '/' : ''));
    resolved.search = search;
    resolved.hash = hash;
  }

  return resolved;
}

/**
 * @param {string} specifier
 * @param {URL} packageJSONUrl
 * @param {string | URL | undefined} base
 */
function importNotDefined(specifier, packageJSONUrl, base) {
  return new ERR_PACKAGE_IMPORT_NOT_DEFINED(
    specifier, packageJSONUrl && fileURLToPath(new URL('.', packageJSONUrl)),
    fileURLToPath(base));
}

/**
 * @param {string} subpath
 * @param {URL} packageJSONUrl
 * @param {string | URL | undefined} base
 */
function exportsNotFound(subpath, packageJSONUrl, base) {
  return new ERR_PACKAGE_PATH_NOT_EXPORTED(
    fileURLToPath(new URL('.', packageJSONUrl)), subpath,
    base && fileURLToPath(base));
}

/**
 *
 * @param {string} request
 * @param {string} match
 * @param {URL} packageJSONUrl
 * @param {boolean} internal
 * @param {string | URL | undefined} base
 */
function throwInvalidSubpath(request, match, packageJSONUrl, internal, base) {
  const reason = `request is not a valid match in pattern "${match}" for the "${
    internal ? 'imports' : 'exports'}" resolution of ${
    fileURLToPath(packageJSONUrl)}`;
  throw new ERR_INVALID_MODULE_SPECIFIER(request, reason,
                                         base && fileURLToPath(base));
}

function invalidPackageTarget(
  subpath, target, packageJSONUrl, internal, base) {
  if (typeof target === 'object' && target !== null) {
    target = JSONStringify(target, null, '');
  } else {
    target = `${target}`;
  }
  return new ERR_INVALID_PACKAGE_TARGET(
    fileURLToPath(new URL('.', packageJSONUrl)), subpath, target,
    internal, base && fileURLToPath(base));
}

const invalidSegmentRegEx = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))?(\\|\/|$)/i;
const deprecatedInvalidSegmentRegEx = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))(\\|\/|$)/i;
const invalidPackageNameRegEx = /^\.|%|\\/;
const patternRegEx = /\*/g;

/**
 *
 * @param {string} target
 * @param {*} subpath
 * @param {*} match
 * @param {*} packageJSONUrl
 * @param {*} base
 * @param {*} pattern
 * @param {*} internal
 * @param {*} isPathMap
 * @param {*} conditions
 * @returns {URL}
 */
function resolvePackageTargetString(
  target,
  subpath,
  match,
  packageJSONUrl,
  base,
  pattern,
  internal,
  isPathMap,
  conditions,
) {

  if (subpath !== '' && !pattern && target[target.length - 1] !== '/')
    throw invalidPackageTarget(match, target, packageJSONUrl, internal, base);

  if (!StringPrototypeStartsWith(target, './')) {
    if (internal && !StringPrototypeStartsWith(target, '../') &&
        !StringPrototypeStartsWith(target, '/')) {
      // No need to convert target to string, since it's already presumed to be
      if (!URLCanParse(target)) {
        const exportTarget = pattern ?
          RegExpPrototypeSymbolReplace(patternRegEx, target, () => subpath) :
          target + subpath;
        return packageResolve(
          exportTarget, packageJSONUrl, conditions);
      }
    }
    throw invalidPackageTarget(match, target, packageJSONUrl, internal, base);
  }

  if (RegExpPrototypeExec(invalidSegmentRegEx, StringPrototypeSlice(target, 2)) !== null) {
    if (RegExpPrototypeExec(deprecatedInvalidSegmentRegEx, StringPrototypeSlice(target, 2)) === null) {
      if (!isPathMap) {
        const request = pattern ?
          StringPrototypeReplace(match, '*', () => subpath) :
          match + subpath;
        const resolvedTarget = pattern ?
          RegExpPrototypeSymbolReplace(patternRegEx, target, () => subpath) :
          target;
        emitInvalidSegmentDeprecation(resolvedTarget, request, match, packageJSONUrl, internal, base, true);
      }
    } else {
      throw invalidPackageTarget(match, target, packageJSONUrl, internal, base);
    }
  }

  const resolved = new URL(target, packageJSONUrl);
  const resolvedPath = resolved.pathname;
  const packagePath = new URL('.', packageJSONUrl).pathname;

  if (!StringPrototypeStartsWith(resolvedPath, packagePath))
    throw invalidPackageTarget(match, target, packageJSONUrl, internal, base);

  if (subpath === '') return resolved;

  if (RegExpPrototypeExec(invalidSegmentRegEx, subpath) !== null) {
    const request = pattern ? StringPrototypeReplace(match, '*', () => subpath) : match + subpath;
    if (RegExpPrototypeExec(deprecatedInvalidSegmentRegEx, subpath) === null) {
      if (!isPathMap) {
        const resolvedTarget = pattern ?
          RegExpPrototypeSymbolReplace(patternRegEx, target, () => subpath) :
          target;
        emitInvalidSegmentDeprecation(resolvedTarget, request, match, packageJSONUrl, internal, base, false);
      }
    } else {
      throwInvalidSubpath(request, match, packageJSONUrl, internal, base);
    }
  }

  if (pattern) {
    return new URL(
      RegExpPrototypeSymbolReplace(patternRegEx, resolved.href, () => subpath),
    );
  }

  return new URL(subpath, resolved);
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function isArrayIndex(key) {
  const keyNum = +key;
  if (`${keyNum}` !== key) return false;
  return keyNum >= 0 && keyNum < 0xFFFF_FFFF;
}

/**
 *
 * @param {*} packageJSONUrl
 * @param {string|[string]} target
 * @param {*} subpath
 * @param {*} packageSubpath
 * @param {*} base
 * @param {*} pattern
 * @param {*} internal
 * @param {*} isPathMap
 * @param {*} conditions
 * @returns {URL|null}
 */
function resolvePackageTarget(packageJSONUrl, target, subpath, packageSubpath,
                              base, pattern, internal, isPathMap, conditions) {
  if (typeof target === 'string') {
    return resolvePackageTargetString(
      target, subpath, packageSubpath, packageJSONUrl, base, pattern, internal,
      isPathMap, conditions);
  } else if (ArrayIsArray(target)) {
    if (target.length === 0) {
      return null;
    }

    let lastException;
    for (let i = 0; i < target.length; i++) {
      const targetItem = target[i];
      let resolveResult;
      try {
        resolveResult = resolvePackageTarget(
          packageJSONUrl, targetItem, subpath, packageSubpath, base, pattern,
          internal, isPathMap, conditions);
      } catch (e) {
        lastException = e;
        if (e.code === 'ERR_INVALID_PACKAGE_TARGET') {
          continue;
        }
        throw e;
      }
      if (resolveResult === undefined) {
        continue;
      }
      if (resolveResult === null) {
        lastException = null;
        continue;
      }
      return resolveResult;
    }
    if (lastException === undefined || lastException === null)
      return lastException;
    throw lastException;
  } else if (typeof target === 'object' && target !== null) {
    const keys = ObjectGetOwnPropertyNames(target);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (isArrayIndex(key)) {
        throw new ERR_INVALID_PACKAGE_CONFIG(
          fileURLToPath(packageJSONUrl), base,
          '"exports" cannot contain numeric property keys.');
      }
    }
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === 'default' || conditions.has(key)) {
        const conditionalTarget = target[key];
        const resolveResult = resolvePackageTarget(
          packageJSONUrl, conditionalTarget, subpath, packageSubpath, base,
          pattern, internal, isPathMap, conditions);
        if (resolveResult === undefined)
          continue;
        return resolveResult;
      }
    }
    return undefined;
  } else if (target === null) {
    return null;
  }
  throw invalidPackageTarget(packageSubpath, target, packageJSONUrl, internal,
                             base);
}

/**
 *
 * @param {import('internal/modules/esm/package_config.js').Exports} exports
 * @param {URL} packageJSONUrl
 * @param {string | URL | undefined} base
 * @returns {boolean}
 */
function isConditionalExportsMainSugar(exports, packageJSONUrl, base) {
  if (typeof exports === 'string' || ArrayIsArray(exports)) return true;
  if (typeof exports !== 'object' || exports === null) return false;

  const keys = ObjectGetOwnPropertyNames(exports);
  let isConditionalSugar = false;
  let i = 0;
  for (let j = 0; j < keys.length; j++) {
    const key = keys[j];
    const curIsConditionalSugar = key === '' || key[0] !== '.';
    if (i++ === 0) {
      isConditionalSugar = curIsConditionalSugar;
    } else if (isConditionalSugar !== curIsConditionalSugar) {
      throw new ERR_INVALID_PACKAGE_CONFIG(
        fileURLToPath(packageJSONUrl), base,
        '"exports" cannot contain some keys starting with \'.\' and some not.' +
        ' The exports object must either be an object of package subpath keys' +
        ' or an object of main entry condition name keys only.');
    }
  }
  return isConditionalSugar;
}

/**
 * @param {URL} packageJSONUrl
 * @param {string} packageSubpath
 * @param {PackageConfig} packageConfig
 * @param {string | URL | undefined} base
 * @param {Set<string>} conditions
 * @returns {URL}
 */
function packageExportsResolve(
  packageJSONUrl, packageSubpath, packageConfig, base, conditions) {
  let exports = packageConfig.exports;
  if (isConditionalExportsMainSugar(exports, packageJSONUrl, base))
    exports = { '.': exports };

  if (ObjectPrototypeHasOwnProperty(exports, packageSubpath) &&
      !StringPrototypeIncludes(packageSubpath, '*') &&
      !StringPrototypeEndsWith(packageSubpath, '/')) {
    const target = exports[packageSubpath];
    const resolveResult = resolvePackageTarget(
      packageJSONUrl, target, '', packageSubpath, base, false, false, false,
      conditions,
    );

    if (resolveResult == null) {
      throw exportsNotFound(packageSubpath, packageJSONUrl, base);
    }

    return resolveResult;
  }

  let bestMatch = '';
  let bestMatchSubpath;
  const keys = ObjectGetOwnPropertyNames(exports);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const patternIndex = StringPrototypeIndexOf(key, '*');
    if (patternIndex !== -1 &&
        StringPrototypeStartsWith(packageSubpath,
                                  StringPrototypeSlice(key, 0, patternIndex))) {
      // When this reaches EOL, this can throw at the top of the whole function:
      //
      // if (StringPrototypeEndsWith(packageSubpath, '/'))
      //   throwInvalidSubpath(packageSubpath)
      //
      // To match "imports" and the spec.
      if (StringPrototypeEndsWith(packageSubpath, '/'))
        emitTrailingSlashPatternDeprecation(packageSubpath, packageJSONUrl,
                                            base);
      const patternTrailer = StringPrototypeSlice(key, patternIndex + 1);
      if (packageSubpath.length >= key.length &&
          StringPrototypeEndsWith(packageSubpath, patternTrailer) &&
          patternKeyCompare(bestMatch, key) === 1 &&
          StringPrototypeLastIndexOf(key, '*') === patternIndex) {
        bestMatch = key;
        bestMatchSubpath = StringPrototypeSlice(
          packageSubpath, patternIndex,
          packageSubpath.length - patternTrailer.length);
      }
    }
  }

  if (bestMatch) {
    const target = exports[bestMatch];
    const resolveResult = resolvePackageTarget(
      packageJSONUrl,
      target,
      bestMatchSubpath,
      bestMatch,
      base,
      true,
      false,
      StringPrototypeEndsWith(packageSubpath, '/'),
      conditions);

    if (resolveResult == null) {
      throw exportsNotFound(packageSubpath, packageJSONUrl, base);
    }
    return resolveResult;
  }

  throw exportsNotFound(packageSubpath, packageJSONUrl, base);
}

function patternKeyCompare(a, b) {
  const aPatternIndex = StringPrototypeIndexOf(a, '*');
  const bPatternIndex = StringPrototypeIndexOf(b, '*');
  const baseLenA = aPatternIndex === -1 ? a.length : aPatternIndex + 1;
  const baseLenB = bPatternIndex === -1 ? b.length : bPatternIndex + 1;
  if (baseLenA > baseLenB) return -1;
  if (baseLenB > baseLenA) return 1;
  if (aPatternIndex === -1) return 1;
  if (bPatternIndex === -1) return -1;
  if (a.length > b.length) return -1;
  if (b.length > a.length) return 1;
  return 0;
}

/**
 * @param {string} name
 * @param {string | URL | undefined} base
 * @param {Set<string>} conditions
 * @returns {URL}
 */
function packageImportsResolve(name, base, conditions) {
  if (name === '#' || StringPrototypeStartsWith(name, '#/') ||
      StringPrototypeEndsWith(name, '/')) {
    const reason = 'is not a valid internal imports specifier name';
    throw new ERR_INVALID_MODULE_SPECIFIER(name, reason, fileURLToPath(base));
  }
  let packageJSONUrl;
  const packageConfig = getPackageScopeConfig(base);
  if (packageConfig.exists) {
    packageJSONUrl = pathToFileURL(packageConfig.pjsonPath);
    const imports = packageConfig.imports;
    if (imports) {
      if (ObjectPrototypeHasOwnProperty(imports, name) &&
          !StringPrototypeIncludes(name, '*')) {
        const resolveResult = resolvePackageTarget(
          packageJSONUrl, imports[name], '', name, base, false, true, false,
          conditions,
        );
        if (resolveResult != null) {
          return resolveResult;
        }
      } else {
        let bestMatch = '';
        let bestMatchSubpath;
        const keys = ObjectGetOwnPropertyNames(imports);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const patternIndex = StringPrototypeIndexOf(key, '*');
          if (patternIndex !== -1 &&
              StringPrototypeStartsWith(name,
                                        StringPrototypeSlice(key, 0,
                                                             patternIndex))) {
            const patternTrailer = StringPrototypeSlice(key, patternIndex + 1);
            if (name.length >= key.length &&
                StringPrototypeEndsWith(name, patternTrailer) &&
                patternKeyCompare(bestMatch, key) === 1 &&
                StringPrototypeLastIndexOf(key, '*') === patternIndex) {
              bestMatch = key;
              bestMatchSubpath = StringPrototypeSlice(
                name, patternIndex, name.length - patternTrailer.length);
            }
          }
        }

        if (bestMatch) {
          const target = imports[bestMatch];
          const resolveResult = resolvePackageTarget(packageJSONUrl, target,
                                                     bestMatchSubpath,
                                                     bestMatch, base, true,
                                                     true, false, conditions);
          if (resolveResult != null) {
            return resolveResult;
          }
        }
      }
    }
  }
  throw importNotDefined(name, packageJSONUrl, base);
}

/**
 * @param {URL} url
 * @returns {import('internal/modules/esm/package_config.js').PackageType}
 */
function getPackageType(url) {
  const packageConfig = getPackageScopeConfig(url);
  return packageConfig.type;
}

/**
 * @param {string} specifier
 * @param {string | URL | undefined} base
 * @returns {{ packageName: string, packageSubpath: string, isScoped: boolean }}
 */
function parsePackageName(specifier, base) {
  let separatorIndex = StringPrototypeIndexOf(specifier, '/');
  let validPackageName = true;
  let isScoped = false;
  if (specifier[0] === '@') {
    isScoped = true;
    if (separatorIndex === -1 || specifier.length === 0) {
      validPackageName = false;
    } else {
      separatorIndex = StringPrototypeIndexOf(
        specifier, '/', separatorIndex + 1);
    }
  }

  const packageName = separatorIndex === -1 ?
    specifier : StringPrototypeSlice(specifier, 0, separatorIndex);

  // Package name cannot have leading . and cannot have percent-encoding or
  // \\ separators.
  if (RegExpPrototypeExec(invalidPackageNameRegEx, packageName) !== null)
    validPackageName = false;

  if (!validPackageName) {
    throw new ERR_INVALID_MODULE_SPECIFIER(
      specifier, 'is not a valid package name', fileURLToPath(base));
  }

  const packageSubpath = '.' + (separatorIndex === -1 ? '' :
    StringPrototypeSlice(specifier, separatorIndex));

  return { packageName, packageSubpath, isScoped };
}

/**
 * @param {string} specifier
 * @param {string | URL | undefined} base
 * @param {Set<string>} conditions
 * @returns {resolved: URL, format? : string}
 */
function packageResolve(specifier, base, conditions) {
  if (BuiltinModule.canBeRequiredWithoutScheme(specifier)) {
    return new URL('node:' + specifier);
  }

  const { packageName, packageSubpath, isScoped } =
    parsePackageName(specifier, base);

  // ResolveSelf
  const packageConfig = getPackageScopeConfig(base);
  if (packageConfig.exists) {
    const packageJSONUrl = pathToFileURL(packageConfig.pjsonPath);
    if (packageConfig.exports != null && packageConfig.name === packageName) {
      return packageExportsResolve(
        packageJSONUrl, packageSubpath, packageConfig, base, conditions);
    }
  }

  let packageJSONUrl =
    new URL('./node_modules/' + packageName + '/package.json', base);
  let packageJSONPath = fileURLToPath(packageJSONUrl);
  let lastPath;
  do {
    const stat = internalModuleStat(toNamespacedPath(StringPrototypeSlice(packageJSONPath, 0,
                                                                          packageJSONPath.length - 13)));
    // Check for !stat.isDirectory()
    if (stat !== 1) {
      lastPath = packageJSONPath;
      packageJSONUrl = new URL((isScoped ?
        '../../../../node_modules/' : '../../../node_modules/') +
        packageName + '/package.json', packageJSONUrl);
      packageJSONPath = fileURLToPath(packageJSONUrl);
      continue;
    }

    // Package match.
    const packageConfig = packageJsonReader.read(packageJSONPath, { __proto__: null, specifier, base, isESM: true });
    if (packageConfig.exports != null) {
      return packageExportsResolve(
        packageJSONUrl, packageSubpath, packageConfig, base, conditions);
    }
    if (packageSubpath === '.') {
      return legacyMainResolve(
        packageJSONUrl,
        packageConfig,
        base,
      );
    }

    return new URL(packageSubpath, packageJSONUrl);
    // Cross-platform root check.
  } while (packageJSONPath.length !== lastPath.length);

  // eslint can't handle the above code.
  // eslint-disable-next-line no-unreachable
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base));
}

/**
 * @param {string} specifier
 * @returns {boolean}
 */
function isBareSpecifier(specifier) {
  return specifier[0] && specifier[0] !== '/' && specifier[0] !== '.';
}

function isRelativeSpecifier(specifier) {
  if (specifier[0] === '.') {
    if (specifier.length === 1 || specifier[1] === '/') return true;
    if (specifier[1] === '.') {
      if (specifier.length === 2 || specifier[2] === '/') return true;
    }
  }
  return false;
}

function shouldBeTreatedAsRelativeOrAbsolutePath(specifier) {
  if (specifier === '') return false;
  if (specifier[0] === '/') return true;
  return isRelativeSpecifier(specifier);
}

/**
 * @param {string} specifier
 * @param {string | URL | undefined} base
 * @param {Set<string>} conditions
 * @param {boolean} preserveSymlinks
 * @returns {url: URL, format?: string}
 */
function moduleResolve(specifier, base, conditions, preserveSymlinks) {
  const isRemote = base.protocol === 'http:' ||
    base.protocol === 'https:';
  // Order swapped from spec for minor perf gain.
  // Ok since relative URLs cannot parse as URLs.
  let resolved;
  if (shouldBeTreatedAsRelativeOrAbsolutePath(specifier)) {
    resolved = new URL(specifier, base);
  } else if (!isRemote && specifier[0] === '#') {
    resolved = packageImportsResolve(specifier, base, conditions);
  } else {
    try {
      resolved = new URL(specifier);
    } catch {
      if (!isRemote) {
        resolved = packageResolve(specifier, base, conditions);
      }
    }
  }
  if (resolved.protocol !== 'file:') {
    return resolved;
  }
  return finalizeResolution(resolved, base, preserveSymlinks);
}

/**
 * Try to resolve an import as a CommonJS module
 * @param {string} specifier
 * @param {string} parentURL
 * @returns {boolean|string}
 */
function resolveAsCommonJS(specifier, parentURL) {
  try {
    const parent = fileURLToPath(parentURL);
    const tmpModule = new CJSModule(parent, null);
    tmpModule.paths = CJSModule._nodeModulePaths(parent);

    let found = CJSModule._resolveFilename(specifier, tmpModule, false);

    // If it is a relative specifier return the relative path
    // to the parent
    if (isRelativeSpecifier(specifier)) {
      found = relative(parent, found);
      // Add '.separator if the path does not start with '..separator'
      // This should be a safe assumption because when loading
      // esm modules there should be always a file specified so
      // there should not be a specifier like '..' or '.'
      if (!StringPrototypeStartsWith(found, `..${sep}`)) {
        found = `.${sep}${found}`;
      }
    } else if (isBareSpecifier(specifier)) {
      // If it is a bare specifier return the relative path within the
      // module
      const pkg = StringPrototypeSplit(specifier, '/')[0];
      const index = StringPrototypeIndexOf(found, pkg);
      if (index !== -1) {
        found = StringPrototypeSlice(found, index);
      }
    }
    // Normalize the path separator to give a valid suggestion
    // on Windows
    if (process.platform === 'win32') {
      found = RegExpPrototypeSymbolReplace(new RegExp(`\\${sep}`, 'g'),
                                           found, '/');
    }
    return found;
  } catch {
    return false;
  }
}

// TODO(@JakobJingleheimer): de-dupe `specifier` & `parsed`
function checkIfDisallowedImport(specifier, parsed, parsedParentURL) {
  if (parsedParentURL) {
    // Avoid accessing the `protocol` property due to the lazy getters.
    const parentProtocol = parsedParentURL.protocol;
    if (
      parentProtocol === 'http:' ||
      parentProtocol === 'https:'
    ) {
      if (shouldBeTreatedAsRelativeOrAbsolutePath(specifier)) {
        // Avoid accessing the `protocol` property due to the lazy getters.
        const parsedProtocol = parsed?.protocol;
        // data: and blob: disallowed due to allowing file: access via
        // indirection
        if (parsedProtocol &&
          parsedProtocol !== 'https:' &&
          parsedProtocol !== 'http:'
        ) {
          throw new ERR_NETWORK_IMPORT_DISALLOWED(
            specifier,
            parsedParentURL,
            'remote imports cannot import from a local location.',
          );
        }

        return { url: parsed.href };
      }
      if (BuiltinModule.canBeRequiredWithoutScheme(specifier)) {
        throw new ERR_NETWORK_IMPORT_DISALLOWED(
          specifier,
          parsedParentURL,
          'remote imports cannot import from a local location.',
        );
      }

      throw new ERR_NETWORK_IMPORT_DISALLOWED(
        specifier,
        parsedParentURL,
        'only relative and absolute specifiers are supported.',
      );
    }
  }
}

/**
 * Validate user-input in `context` supplied by a custom loader.
 */
function throwIfInvalidParentURL(parentURL) {
  if (parentURL === undefined) {
    return; // Main entry point, so no parent
  }
  if (typeof parentURL !== 'string' && !isURL(parentURL)) {
    throw new ERR_INVALID_ARG_TYPE('parentURL', ['string', 'URL'], parentURL);
  }
}


function defaultResolve(specifier, context = {}) {
  let { parentURL, conditions } = context;
  throwIfInvalidParentURL(parentURL);
  if (parentURL && policy?.manifest) {
    const redirects = policy.manifest.getDependencyMapper(parentURL);
    if (redirects) {
      const { resolve, reaction } = redirects;
      const destination = resolve(specifier, new SafeSet(conditions));
      let missing = true;
      if (destination === true) {
        missing = false;
      } else if (destination) {
        const href = destination.href;
        return { __proto__: null, url: href };
      }
      if (missing) {
        // Prevent network requests from firing if resolution would be banned.
        // Network requests can extract data by doing things like putting
        // secrets in query params
        reaction(new ERR_MANIFEST_DEPENDENCY_MISSING(
          parentURL,
          specifier,
          ArrayPrototypeJoin([...conditions], ', ')),
        );
      }
    }
  }

  let parsedParentURL;
  if (parentURL) {
    try {
      parsedParentURL = new URL(parentURL);
    } catch {
      // Ignore exception
    }
  }

  let parsed;
  try {
    if (shouldBeTreatedAsRelativeOrAbsolutePath(specifier)) {
      parsed = new URL(specifier, parsedParentURL);
    } else {
      parsed = new URL(specifier);
    }

    // Avoid accessing the `protocol` property due to the lazy getters.
    const protocol = parsed.protocol;
    if (protocol === 'data:' ||
      (experimentalNetworkImports &&
        (
          protocol === 'https:' ||
          protocol === 'http:'
        )
      )
    ) {
      return { __proto__: null, url: parsed.href };
    }
  } catch {
    // Ignore exception
  }

  // There are multiple deep branches that can either throw or return; instead
  // of duplicating that deeply nested logic for the possible returns, DRY and
  // check for a return. This seems the least gnarly.
  const maybeReturn = checkIfDisallowedImport(
    specifier,
    parsed,
    parsedParentURL,
  );

  if (maybeReturn) return maybeReturn;

  // This must come after checkIfDisallowedImport
  if (parsed && parsed.protocol === 'node:') return { __proto__: null, url: specifier };


  const isMain = parentURL === undefined;
  if (isMain) {
    parentURL = pathToFileURL(`${process.cwd()}/`).href;

    // This is the initial entry point to the program, and --input-type has
    // been passed as an option; but --input-type can only be used with
    // --eval, --print or STDIN string input. It is not allowed with file
    // input, to avoid user confusion over how expansive the effect of the
    // flag should be (i.e. entry point only, package scope surrounding the
    // entry point, etc.).
    if (typeFlag) throw new ERR_INPUT_TYPE_NOT_ALLOWED();
  }

  conditions = getConditionsSet(conditions);
  let url;
  try {
    url = moduleResolve(
      specifier,
      parentURL,
      conditions,
      isMain ? preserveSymlinksMain : preserveSymlinks,
    );
  } catch (error) {
    // Try to give the user a hint of what would have been the
    // resolved CommonJS module
    if (error.code === 'ERR_MODULE_NOT_FOUND' ||
        error.code === 'ERR_UNSUPPORTED_DIR_IMPORT') {
      if (StringPrototypeStartsWith(specifier, 'file://')) {
        specifier = fileURLToPath(specifier);
      }
      const found = resolveAsCommonJS(specifier, parentURL);
      if (found) {
        // Modify the stack and message string to include the hint
        const lines = StringPrototypeSplit(error.stack, '\n');
        const hint = `Did you mean to import ${found}?`;
        error.stack =
          ArrayPrototypeShift(lines) + '\n' +
          hint + '\n' +
          ArrayPrototypeJoin(lines, '\n');
        error.message += `\n${hint}`;
      }
    }
    throw error;
  }

  return {
    __proto__: null,
    // Do NOT cast `url` to a string: that will work even when there are real
    // problems, silencing them
    url: url.href,
    format: defaultGetFormatWithoutErrors(url, context),
  };
}

module.exports = {
  defaultResolve,
  encodedSepRegEx,
  getPackageScopeConfig,
  getPackageType,
  packageExportsResolve,
  packageImportsResolve,
  throwIfInvalidParentURL,
  legacyMainResolve,
};

// cycle
const {
  defaultGetFormatWithoutErrors,
} = require('internal/modules/esm/get_format');

if (policy) {
  const $defaultResolve = defaultResolve;
  module.exports.defaultResolve = function defaultResolve(
    specifier,
    context,
  ) {
    const ret = $defaultResolve(specifier, context);
    // This is a preflight check to avoid data exfiltration by query params etc.
    policy.manifest.mightAllow(ret.url, () =>
      new ERR_MANIFEST_DEPENDENCY_MISSING(
        context.parentURL,
        specifier,
        context.conditions,
      ),
    );
    return ret;
  };
}
