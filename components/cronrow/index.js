// 定时任务消息行：会话列表的「最近消息」和历史记录页共用同一套展示。
Component({
  properties: {
    item: { type: Object, value: {} }
  },

  methods: {
    onTap() {
      const item = this.data.item || {}
      this.triggerEvent('open', {
        id: item.id || '',
        cwd: item.cwd || '',
        title: item.title || ''
      })
    }
  }
})
