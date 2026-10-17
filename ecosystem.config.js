module.exports = {
  apps: [{
    name: 'market-bot',
    script: 'index.js',
    env_production: { NODE_ENV: 'production' },
    max_restarts: 10,
    restart_delay: 5000,
  }],
};