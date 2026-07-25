// ecosystem.config.cjs — REFERENCE COPY only.
//
// This file is NOT used directly by PM2 on the server.
// deploy.sh generates the live copy at $APP_DIR/ecosystem.config.cjs,
// replacing APP_DIR_PLACEHOLDER with the real absolute path at deploy time.
//
// To update the PM2 app definitions, edit this file and re-deploy.

module.exports = {
  apps: [
    {
      name: 'url-api',
      script: 'server/api/dist/server.js',
      cwd: 'APP_DIR_PLACEHOLDER',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--experimental-vm-modules',
      env: { NODE_ENV: 'production' },
      error_file: 'APP_DIR_PLACEHOLDER/logs/api-error.log',
      out_file: 'APP_DIR_PLACEHOLDER/logs/api-out.log',
    },
    {
      name: 'url-redirect',
      script: 'server/redirect/dist/server.js',
      cwd: 'APP_DIR_PLACEHOLDER',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--experimental-vm-modules',
      env: { NODE_ENV: 'production' },
      error_file: 'APP_DIR_PLACEHOLDER/logs/redirect-error.log',
      out_file: 'APP_DIR_PLACEHOLDER/logs/redirect-out.log',
    },
    {
      name: 'url-worker',
      script: 'server/worker/dist/worker.js',
      cwd: 'APP_DIR_PLACEHOLDER',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--experimental-vm-modules',
      env: { NODE_ENV: 'production' },
      error_file: 'APP_DIR_PLACEHOLDER/logs/worker-error.log',
      out_file: 'APP_DIR_PLACEHOLDER/logs/worker-out.log',
    },
  ],
};
