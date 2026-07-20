module.exports = {
  apps: [
    {
      name: 'codeflowmu-shell',
      script: 'node_modules/tsx/dist/cli.cjs',
      args: 'src/main.ts',
      cwd: 'D:\\codeflowmu\\codeflowmu-shell',
      interpreter: 'node',

      // ???????????????
      autorestart: true,
      watch: false,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 3000,
      exp_backoff_restart_delay: 100,

      // ??????????????? 3.5GB ??????????????? OOM??      max_memory_restart: '3500M',

      // ?????
      out_file: 'D:\\codeflowmu\\.codeflowmu-stdout.log',
      error_file: 'D:\\codeflowmu\\.codeflowmu-stderr.log',
      merge_logs: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // ??????????
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--max-old-space-size=3072',
      },
    },
  ],
};

