// ============================================================
// PM2 конфиг для KDL Checklist
// Запуск:   pm2 start ecosystem.config.js
// Логи:     pm2 logs kdl-checklist
// Рестарт:  pm2 restart kdl-checklist
// Стоп:     pm2 stop kdl-checklist
// ============================================================

module.exports = {
  apps: [
    {
      name: 'kdl-checklist',
      script: 'server.js',
      cwd: __dirname,

      // Один инстанс — состояние в одном JSON-файле,
      // параллельные записи приведут к race condition
      instances: 1,
      exec_mode: 'fork',

      // Автоперезапуск
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,

      // Переменные окружения
      env: {
        NODE_ENV: 'production',
        PORT: 8444,
        DATA_DIR: 'data',
        PUBLIC_DIR: 'public'
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 8444,
        DATA_DIR: 'data',
        PUBLIC_DIR: 'public'
      },

      // Логи
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
      merge_logs: true,
      time: true,

      // Не убивать по SIGINT сразу — дать серверу корректно закрыться
      kill_timeout: 5000,
      listen_timeout: 10000
    }
  ]
};