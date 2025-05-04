# koishi-plugin-webhook-recoder

[![npm](https://img.shields.io/npm/v/koishi-plugin-webhook-recoder?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-webhook-recoder)
[![npm-download](https://img.shields.io/npm/dm/koishi-plugin-webhook-recoder?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-webhook-recoder)
[![github](https://img.shields.io/github/stars/dqsq2e2/koishi-plugin-webhook-recoder?style=flat-square)](https://github.com/dqsq2e2/koishi-plugin-webhook-recoder)

监听指定 Webhook 地址并格式化消息发送的 Koishi 插件，支持保存最新消息并通过自定义指令获取。

## 最新更新 (v2.1.0)

- 完善指令响应系统，现在指令只会回复发送者本人或所在群组
- 优化消息会话ID识别逻辑，更准确地支持群聊/私聊场景
- 增加详细的指令处理日志，方便调试

## 功能

- 监听指定 Webhook 地址
- 支持 GET/POST 请求
- 支持自定义头信息验证
- 支持将消息转发至机器人
- **特色功能**：保存最新消息并通过自定义指令获取

## 安装

```bash
npm i koishi-plugin-webhook-recoder@2.1.0
```

或者在 Koishi 插件市场搜索 `webhook-recoder` 安装最新版本。

## 配置说明

### 基本配置

插件配置中，每个键值对表示一个 Webhook 路径及其处理方式：

```yaml
'/api':                           # Webhook 路径
  method: post                    # 监听方式：get 或 post
  headers:                        # 请求头检查（可选）
    token: 'your-secret-token'    # 如设置了请求头检查，则必须匹配
  response:                       # 响应配置
    - platform: onebot            # 机器人平台
      sid: '123456789'            # 机器人 ID
      seeisonId:                  # 发送目标（群/私聊）
        - '123456789'             # 群号
        - 'private:987654321'     # 私聊对象需要添加 private: 前缀
      msg:                        # 发送的消息模板
        - '{server}地址已更新：{address}:{port}'
        - '更新时间：{timestamp}'
  saveLatestMessage: true         # 是否保存最新消息（新增）
  customCommand: '/latest'        # 获取最新消息的指令（新增）
```

### 消息模板

在消息模板中，使用 `{key}` 格式可以引用 Webhook 请求中的数据。例如：

- GET 请求：`/api?name=koishi&version=1.0.0`，可通过 `{name}` 和 `{version}` 引用
- POST 请求：请求体 `{"name": "koishi", "version": "1.0.0"}`，同样可通过 `{name}` 和 `{version}` 引用

### 新增功能使用说明

1. 设置 `saveLatestMessage: true` 开启保存最新消息功能
2. 设置 `customCommand` 为你想使用的指令，例如 `/latest`
3. 当 Webhook 接收到消息后，会保存最新的消息内容
4. 当用户在相应的群/私聊中发送设置的指令时，机器人会使用与原始消息模板相同的格式输出最新保存的消息内容

## 应用场景

- Minecraft 服务器状态监控
- GitHub Webhook 通知
- CI/CD 流程通知
- 各类系统监控通知
- 自定义 API 集成

## 示例

### Minecraft 服务器状态更新

```yaml
'/mc-server':
  method: post
  headers:
    token: 'secret-mc-token'
  response:
    - platform: onebot
      sid: '123456789'
      seeisonId:
        - '123456789'
      msg:
        - '{server}地址已更新：{address}:{port}'
  saveLatestMessage: true
  customCommand: '/mc-status'
```

当 `/mc-server` 接收到 POST 请求 `{"server": "我的世界服务器", "address": "110.14.122.59", "port": 14276}` 时：

1. 自动发送消息：`我的世界服务器地址已更新：110.14.122.59:14276`
2. 保存这条消息
3. 当用户在群里发送 `/mc-status` 时，机器人会再次发送：`我的世界服务器地址已更新：110.14.122.59:14276`

## 注意事项

- 同一个 Webhook 路径只能保存一条最新消息，新消息会覆盖旧消息
- 自定义指令只在配置了相应 `seeisonId` 的群/私聊中有效
- 必须为每个需要此功能的 Webhook 路径单独配置

## 相关链接

- [项目主页](https://github.com/dqsq2e2/koishi-plugin-webhook-recoder)
- [问题反馈](https://github.com/dqsq2e2/koishi-plugin-webhook-recoder/issues)
- [更新日志](https://github.com/dqsq2e2/koishi-plugin-webhook-recoder/blob/main/CHANGELOG.md)

## 许可证

使用 [MIT](https://github.com/dqsq2e2/koishi-plugin-webhook-recoder/blob/main/LICENSE) 许可证 