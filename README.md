# koishi-plugin-webhook-recoder

[![npm](https://img.shields.io/npm/v/koishi-plugin-webhook-recoder?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-webhook-recoder)
[![forum](https://img.shields.io/badge/Koishi%20Forum-Plugin%20Post-blue?style=flat-square)](https://forum.koishi.xyz/t/topic/10958)
[![video](https://img.shields.io/badge/Tutorial-Video-red?style=flat-square)](https://www.bilibili.com/video/BV1mtVNz1EzZ)
[![github](https://img.shields.io/github/stars/dqsq2e2/koishi-plugin-webhook-recoder?style=flat-square)](https://github.com/dqsq2e2/koishi-plugin-webhook-recoder)

一个用于接收并记录Webhook请求的Koishi插件，支持多种平台的消息转发和查询。最新版本优化了消息展示格式，修复了序号显示问题，并增强了权限控制，使你可以更高效地管理和检索历史消息。

## 功能特点

- 支持监听多个Webhook路径
- 可配置接收到请求后，将消息转发给指定的平台/群组/用户
- 支持GET和POST请求及请求头校验
- 支持记录最新的请求数据，并通过命令查询
- 支持自定义命令，快速获取指定路径的最新消息
- 支持平台特定的命令，如仅对onebot平台可用的命令
- 支持保存最新接收的消息
- 提供自定义指令获取最新保存的消息
- 支持使用指令选项查询不同路径的消息
- 支持持久化存储消息，重启后不丢失
- 可配置是否在接收webhook请求后立即转发消息
- 支持存储多条历史消息，并根据索引查询指定消息
- 提供消息管理功能，可删除单条、多条或所有历史消息
- 自动管理消息历史，当超过最大限制时自动移除最旧的消息
- 支持范围查询功能，可使用 `-n 2-5` 查询指定范围的消息
- 精确的序号显示：查询结果显示的序号与请求的索引一致
- 智能时间戳显示：仅在使用索引查询或范围查询时显示
- 严格的权限控制：必须开启 `storeAllMessages` 才能使用 `-n` 或 `-d` 选项

## 安装

```bash
npm install koishi-plugin-webhook-recoder
# 或者使用yarn
yarn add koishi-plugin-webhook-recoder
```

## 配置

插件支持以下配置项：

```typescript
{
  "/api": {                        // Webhook路径
    "method": "get",               // 请求方式：get或post
    "headers": {                   // 请求头校验
      "X-Api-Key": "your-api-key"
    },
    "response": [                  // 配置响应目标
      {
        "platform": "onebot",      // 目标平台
        "sid": "bot-id",           // 机器人ID
        "seeisonId": [             // 消息接收对象
          "group-id",              // 群组ID
          "private:user-id"        // 私聊用户ID（带private:前缀）
        ],
        "msg": [                   // 消息模板
          "收到新请求: {name}",      // 支持{key}形式的占位符
          "详情: {detail}"          // 多行消息会用换行符合并
        ],
        "saveLatestMessage": true,  // 是否保存最新消息
        "persistMessages": true,    // 是否持久化保存消息到磁盘
        "storeAllMessages": true,    // 是否存储所有接收到的消息（设为false时仅保存最新消息）
        "maxStoredMessages": 50,     // 最大存储消息数量（仅在storeAllMessages为true时有效）
        "customCommand": "latest-api",  // 自定义命令名，用于查询最新消息
        "commandDescription": "获取最新API请求" // 命令描述
      }
    ],
    "saveLatestMessage": true,     // 是否保存最新消息
    "persistMessages": true,      // 是否持久化保存消息到磁盘
    "storeAllMessages": true,     // 是否存储所有接收到的消息历史记录（设为false时仅保存最新消息）
    "maxStoredMessages": 50,      // 最大存储消息数量（防止消息过多占用内存，仅在storeAllMessages为true时有效）
    "customCommand": "latest-api",  // 自定义命令名，用于查询最新消息
    "commandDescription": "获取最新API请求", // 命令描述
    "instantForward": true       // 是否在接收到webhook后立即转发消息
  },
  "persistPath": "./data/webhook-messages"  // 消息持久化存储路径
}
```

### 配置说明

- **Webhook路径**：定义要监听的URL路径，如 `/api`、`/github` 等
- **method**：指定接受的HTTP请求方法，支持 `get` 或 `post`
- **headers**：可选的请求头验证，所有指定的头信息都必须匹配才会处理请求
- **response**：定义请求处理后的响应行为
  - **platform**：目标机器人平台（如 onebot、kook 等）
  - **sid**：目标机器人的ID
  - **seeisonId**：消息发送目标（群组ID或私聊用户ID，私聊需加 `private:` 前缀）
  - **msg**：消息模板，支持使用 `{key}` 引用请求中的数据
- **saveLatestMessage**：是否保存最新接收到的消息（用于后续查询）
- **persistMessages**：是否持久化保存消息到磁盘
- **storeAllMessages**：是否存储所有接收到的消息历史记录（设为false时仅保存最新消息，且无法使用-n或-d选项）
- **maxStoredMessages**：最大存储消息数量（防止消息过多占用内存，超过此限制时自动移除最旧的消息）
- **customCommand**：定义用于获取最新消息的自定义命令（不需要 `/` 前缀）
- **commandDescription**：命令的描述文本，会显示在帮助信息中
- **instantForward**：是否在接收到webhook请求后立即转发消息（默认为true，设为false时仅保存不转发）
- **persistPath**：消息持久化存储路径

## 使用方法

### 1. 配置Webhook路径

在配置中设置你需要监听的Webhook路径，如`/api`，并配置相应的处理方式。

### 2. 接收和转发消息

当Webhook接收到请求时，会根据配置将消息转发到指定的目标。例如，当有POST请求发送到`/api`时，会将消息转发到配置的群组或私聊。

消息中的占位符`{key}`会被请求中的对应字段替换：
- GET请求：URL查询参数会被用于替换，例如 `/api?name=koishi` 中的 `{name}` 会被替换为 `koishi`
- POST请求：请求体中的JSON数据会被用于替换，例如请求体 `{"name":"koishi"}` 中的 `{name}` 会被替换为 `koishi`

对于嵌套的JSON数据，可以使用点号访问，例如 `{user.name}` 可以获取 `{"user":{"name":"koishi"}}` 中的 `koishi`。

### 3. 查询最新消息

#### 自定义命令及选项

如果你在配置中设置了`customCommand`和`saveLatestMessage: true`，可以使用自定义命令查询指定路径的最新消息。

**基本用法**：

```
命令名
```

例如，如果配置了 `customCommand: "github"`，则使用：

```
github
```

**选项说明**：

每个自定义命令都支持以下选项：

1. `-p, --path <path>` - 指定要查询的Webhook路径
   
   允许你查询不同于默认路径的其他Webhook路径的最新消息：
   
   ```
   github -p /gitlab
   ```
   
   这个命令会查询被指定 `/gitlab` 路径的最新消息，而不是默认的路径。

2. `-n, --number <number>` - 指定要查询的消息索引或全部消息
   
   允许你查询指定索引的历史消息、指定范围的消息或所有消息：
   
   ```
   github -n 1     # 查询最新的一条消息（默认）
   github -n 3     # 查询第3条最新消息
   github -n 2-5   # 查询第2到第5条消息范围
   github -n all   # 查询所有保存的消息
   github -n a     # 'all'的简写，查询所有消息
   ```
   
   **注意**：必须开启 `storeAllMessages` 选项才能使用 `-n` 选项。索引从1开始，1表示最新消息，2表示第二新的消息，以此类推。

3. `-d, --delete <range>` - 删除指定范围的消息
   
   允许你删除一条、多条或所有消息：
   
   ```
   github -d 3        # 删除第3条消息
   github -d 2-5      # 删除第2至第5条消息
   github -d all      # 删除所有消息
   github -d a        # 'all'的简写，删除所有消息
   github -d old      # 删除最新消息以外的所有消息
   github -d o        # 'old'的简写，删除最新消息以外的所有消息
   ```
   
   **注意**：必须开启 `storeAllMessages` 选项才能使用 `-d` 选项。

4. `-h, --help` - 显示命令帮助
   
   ```
   github -h
   ```
   
   这会显示命令的帮助信息，包括可用的选项和用法说明。

#### 通用查询命令（仅onebot平台）

插件还提供了一个仅对onebot平台可用的通用查询命令：

```
webhook-latest [path]
```

**用法**：

- 不带参数：列出所有可用的Webhook路径
  ```
  webhook-latest
  ```
  
- 带路径参数：查询指定路径的最新消息
  ```
  webhook-latest /github
  ```

这个命令对于管理员特别有用，可以快速查看系统中所有已配置的Webhook路径，并随时查询任何路径的最新消息，而不需要为每个路径配置单独的命令。

## 示例

### 配置示例

```json
{
  "/github": {
    "method": "post",
    "saveLatestMessage": true,
    "persistMessages": true,
    "customCommand": "github",
    "commandDescription": "获取最新GitHub推送",
    "response": [
      {
        "platform": "onebot",
        "sid": "123456789",
        "seeisonId": ["group-id", "private:user-id"],
        "msg": [
          "收到新的GitHub推送",
          "仓库: {repository.name}",
          "提交者: {sender.login}",
          "消息: {head_commit.message}"
        ]
      }
    ]
  }
}
```

### 使用示例

1. **接收并转发消息**

   当有GitHub Webhook请求发送到`/github`路径时，机器人会自动将消息转发到配置的群组和私聊。

2. **使用自定义命令查询最新消息**

   用户可以使用以下命令查询最新的GitHub推送：
   ```
   github
   ```
   
   或者使用选项指定其他路径：
   ```
   github -p /gitlab
   ```

3. **使用通用命令查询（仅onebot平台）**

   Onebot平台的用户还可以使用：
   ```
   webhook-latest /github
   ```
   
   或者查看所有可用路径：
   ```
   webhook-latest
   ```

## 常见问题

1. **自定义命令不起作用？**
   - 确保配置了 `saveLatestMessage`
   - 确保命令名不带 `/` 前缀（配置时）
   - 确保你在配置了 `seeisonId` 的群组或私聊中使用命令

2. **如何同时监听多个Webhook路径？**
   - 在配置中添加多个路径键值对，每个路径可以有不同的配置

3. **无法使用 -n 或 -d 选项？**
   - 检查对应路径是否开启了 `storeAllMessages` 选项
   - 只有开启了 `storeAllMessages` 的路径才能使用这些选项

4. **如何测试Webhook？**
   - 可以使用工具如 Postman 或 curl 发送测试请求
   - 例如：`curl -X POST -H "Content-Type: application/json" -d '{"name":"test"}' http://yourserver:port/api`

## 更新日志

查看 [CHANGELOG.md](https://github.com/dqsq2e2/koishi-plugin-webhook-recoder/blob/main/CHANGELOG.md) 获取完整更新历史。

## 许可证

MIT 