const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');
const fs = require('fs');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch all files in the monorepo
config.watchFolders = [monorepoRoot];

// Let Metro know where to resolve packages from
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (/^@tallyui\/[^/]+$/.test(moduleName)) {
    const packageDir = fs.realpathSync(path.join(projectRoot, 'node_modules', moduleName));
    const filePath = path.join(packageDir, 'src/index.ts');
    return { type: 'sourceFile', filePath };
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Uniwind must be the outermost wrapper
module.exports = withUniwindConfig(config, {
  cssEntryFile: './global.css',
});
