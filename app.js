const store = require('./utils/store')
const theme = require('./utils/theme')

App({
  globalData: {
    pendingChat: null
  },

  onLaunch() {
    store.migrate()
    theme.apply()
  }
})
