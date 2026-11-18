import path from 'node:path';

// Minimal glob support, enough for protected paths:
//   **  any number of directories
//   *   anything except "/"
//   ?   one character except "/"
// Kept dependency-free on purpose: the runtime is vendored into each project.

const cache = new Map();

/** @param {string} glob */
export function globToRegExp(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches zero or more directories.
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const compiled = new RegExp(`^${re}$`);
  cache.set(glob, compiled);
  return compiled;
}

/**
 * Turns an absolute or relative path into a POSIX path relative to the project root.
 * @param {string} filePath
 * @param {string} root
 */
export function toProjectPath(filePath, root) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  return path.relative(root, absolute).split(path.sep).join('/');
}

/**
 * @param {string} projectPath
 * @param {string} glob
 */
export function matches(projectPath, glob) {
  return globToRegExp(glob).test(projectPath);
}
