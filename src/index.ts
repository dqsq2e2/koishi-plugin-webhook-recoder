import { Bot, Context, Logger, Schema } from 'koishi'
import type { Next } from 'koishi'
import type { Context as KoaContext } from 'koa'
import type { Session } from 'koishi'
import * as fs from 'node:fs'
import * as path from 'node:path'

// 为Koa的Request接口添加body属性
declare module 'koa' {
    interface Request {
        body?: any;
        query?: any;
    }
}

// 存储最新接收到的消息
interface StoredMessage {
    body: varDict;
    timestamp: number;
    path: string;
}

const latestMessages: { [key: string]: StoredMessage } = {}

export const name = 'webhook-recoder'
export const inject = ['server']

export interface responseType {
    platform: string
    sid: string
    seeisonId: string[]
    msg: string[]
}

export interface Webhook {
    method: string,
    headers: { [key: string]: string }
    response: responseType[]
    saveLatestMessage?: boolean
    customCommand?: string
    commandDescription?: string
    persistMessages?: boolean
}

// 使用独立的配置接口定义，将persistPath移出索引签名范围
export interface Config {
    [key: string]: Webhook | string | undefined
    persistPath?: string
}

// 扩展Context接口，添加server属性
declare module 'koishi' {
    interface Context {
        server: {
            [method: string]: (path: string, ...middleware: any[]) => void
        }
    }
}

// 定义配置Schema
const WebhookSchema = Schema.object({
    method: Schema.union(['get', 'post']).default('get').description('监听方式'),
    headers: Schema.dict(Schema.string()).role('table').description('检查头 如果填写则需要在请求头中包含'),
    response: Schema.array(Schema.object({
        platform: Schema.union(['onebot', 'kook', 'telegram', 'discord', 'lark', 'chronocat']).default('onebot').description('机器人平台'),
        sid: Schema.string().required().description('机器人id，用于获取Bot对象'),
        seeisonId: Schema.array(Schema.string().required()).role('table').description('群聊/私聊对象id,私聊对象需在前方加上`private:`,如`private:123456`'),
        msg: Schema.array(Schema.string().default("hello {name}.")).role('table').required().description('需要发送的信息，会使用换行符合并<br>接收的body会按照JSON解析，并将key以{key}形式全替换字符串内容')
    })).description('响应'),
    saveLatestMessage: Schema.boolean().default(false).description('是否保存最新消息'),
    customCommand: Schema.string().description('触发发送最新保存消息的指令，例如：latest'),
    commandDescription: Schema.string().description('指令的描述'),
    persistMessages: Schema.boolean().default(false).description('是否将最新消息持久化保存到磁盘')
})

// 创建完整的配置Schema
export const Config = Schema.intersect([
    Schema.dict(WebhookSchema).description("监听指定路径，如:`/api`"),
    Schema.object({
        persistPath: Schema.string().default('./data/webhook-messages').description('持久化存储的路径，相对于 koishi 工作目录')
    })
])

export interface varDict {
    [key: string]: string
}

function sendResponseMsg(bot: Bot, platform: string, rep: responseType, dict: varDict){
    let msg = rep.msg.join("\n");
    for(const key in dict) {
        msg = msg.replace(new RegExp(`{${key}}`, 'g'), dict[key]);
    }
    rep.seeisonId.forEach(element => {
        bot.createMessage(element, msg);
    });
}

// 发送最新保存的消息
function sendLatestMessage(bot: Bot, sessionId: string, path: string, config: Config) {
    const storedMessage = latestMessages[path];
    if (!storedMessage) {
        return bot.createMessage(sessionId, `暂无来自 ${path} 的最新消息`);
    }
    
    // 查找当前路径的配置
    const pathConfig = config[path] as Webhook | undefined;
    if (!pathConfig || !pathConfig.response) {
        return bot.createMessage(sessionId, `找不到 ${path} 的配置信息`);
    }
    
    // 查找匹配当前会话的响应配置
    for (const rep of pathConfig.response) {
        if (rep.seeisonId.includes(sessionId)) {
            // 创建一个只包含当前会话ID的响应配置副本
            const singleSessionResponse: responseType = {
                ...rep,
                seeisonId: [sessionId]  // 只包含当前会话ID
            };
            
            // 使用相同的msg模板和替换逻辑，但只发送到当前会话
            sendResponseMsg(bot, rep.platform, singleSessionResponse, storedMessage.body);
            return;
        }
    }
    
    // 如果没有找到匹配的响应配置，使用保存的数据直接发送
    bot.createMessage(sessionId, `来自 ${path} 的最新消息：${JSON.stringify(storedMessage.body, null, 2)}`);
}

// 持久化保存消息到文件
function persistMessage(messagePath: string, message: StoredMessage, persistPath: string, logger: Logger) {
    try {
        // 创建目录（如果不存在）
        const dirPath = path.resolve(persistPath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            logger.info(`创建持久化存储目录: ${dirPath}`);
        }
        
        // 规范化路径名（替换特殊字符）
        const safePathName = messagePath.replace(/[\/\\:*?"<>|]/g, '_');
        const filePath = path.join(dirPath, `${safePathName}.json`);
        
        // 写入文件
        fs.writeFileSync(filePath, JSON.stringify(message, null, 2), 'utf8');
        logger.info(`已持久化保存来自 ${messagePath} 的消息到 ${filePath}`);
    } catch (error) {
        logger.error(`持久化保存消息失败: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// 从文件加载持久化的消息
function loadPersistedMessages(persistPath: string, logger: Logger) {
    try {
        const dirPath = path.resolve(persistPath);
        if (!fs.existsSync(dirPath)) {
            logger.info(`持久化存储目录不存在，将在收到消息时创建: ${dirPath}`);
            return;
        }
        
        // 读取目录中的所有JSON文件
        const files = fs.readdirSync(dirPath).filter(file => file.endsWith('.json'));
        logger.info(`找到 ${files.length} 个持久化消息文件`);
        
        // 加载每个文件的内容
        for (const file of files) {
            try {
                const filePath = path.join(dirPath, file);
                const content = fs.readFileSync(filePath, 'utf8');
                const message = JSON.parse(content) as StoredMessage;
                
                // 还原原始路径名（从文件名提取）
                const originalPath = message.path;
                latestMessages[originalPath] = message;
                logger.info(`已加载来自 ${originalPath} 的持久化消息`);
            } catch (error) {
                logger.error(`加载文件 ${file} 失败: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    } catch (error) {
        logger.error(`加载持久化消息失败: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function apply(ctx: Context, config: Config) {
    const logger = ctx.logger(name);
    
    // 获取持久化存储路径
    const persistPath = config.persistPath || './data/webhook-messages';
    
    // 尝试加载持久化的消息
    loadPersistedMessages(persistPath, logger);

    // 注册自定义指令处理器
    for (let path in config) {
        // 跳过全局配置项
        if (path === 'persistPath') continue;
        
        const item = config[path] as Webhook;
        if (item && item.customCommand) {
            // 使用正确的指令注册方式
            const commandName = item.customCommand.startsWith('/') ? item.customCommand.slice(1) : item.customCommand;
            
            ctx.command(commandName, item.commandDescription || `获取来自 ${path} 的最新消息`)
                .option('path', '-p <path>', { fallback: path })
                .action(async ({ session, options }) => {
                    if (!session) return '无法获取会话信息';
                    
                    // 确定当前会话的ID
                    let currentSessionId: string;
                    
                    // 区分群聊和私聊
                    if (session.subtype === 'group') {
                        // 群聊消息，使用群ID作为会话ID
                        currentSessionId = session.channelId;
                    } else if (session.subtype === 'private') {
                        // 私聊消息，使用带private:前缀的用户ID作为会话ID
                        currentSessionId = `private:${session.userId}`;
                    } else {
                        // 其他类型的消息，使用默认逻辑
                        currentSessionId = session.guildId ? session.channelId : `private:${session.userId}`;
                    }
                    
                    logger.info(`收到指令 ${commandName}，会话ID: ${currentSessionId}`);
                    
                    // 使用用户指定的路径或默认路径
                    const targetPath = options?.path || path;
                    
                    // 找到匹配的机器人
                    const botId = `${session.platform}:${session.selfId}`;
                    const bot = ctx.bots[botId];
                    if (!bot) {
                        return `找不到匹配的机器人: ${botId}`;
                    }
                    
                    // 发送最新消息
                    sendLatestMessage(bot, currentSessionId, targetPath, config);
                });
        }
    }

    // 使用ctx.intersect注册一个只对特定平台可用的指令
    // 例如，只对onebot平台可用的webhook-latest指令
    ctx.intersect(session => session.platform === 'onebot')
        .command('webhook-latest [path]', '获取指定Webhook路径的最新消息')
        .action(async ({ session }, path) => {
            if (!session) return '无法获取会话信息';
            
            if (!path) {
                // 如果没有指定路径，列出所有可用的路径
                const paths = Object.keys(latestMessages);
                if (paths.length === 0) {
                    return '目前没有任何保存的消息';
                }
                return `可用的Webhook路径: ${paths.join(', ')}`;
            }
            
            // 确定当前会话的ID
            let currentSessionId: string;
            
            // 区分群聊和私聊
            if (session.subtype === 'group') {
                currentSessionId = session.channelId;
            } else if (session.subtype === 'private') {
                currentSessionId = `private:${session.userId}`;
            } else {
                currentSessionId = session.guildId ? session.channelId : `private:${session.userId}`;
            }
            
            // 获取机器人
            const botId = `${session.platform}:${session.selfId}`;
            const bot = ctx.bots[botId];
            if (!bot) {
                return `找不到匹配的机器人: ${botId}`;
            }
            
            // 发送最新消息
            sendLatestMessage(bot, currentSessionId, path, config);
        });

    for (let path in config) {
        // 跳过全局配置项
        if (path === 'persistPath') continue;
        
        const item = config[path] as Webhook;
        if (!item || !item.method) continue;

        ctx.server[item.method](path, (c: KoaContext, next: Next) => {
            logger.info(`接收到 ${item.method} 请求：${path}`)
            // 对于类型检查，我们需要这样处理，但行为与原代码保持一致
            // @ts-ignore - 保持与原代码相同的行为
            for (let httpheader in config.headers) {// 检查头，如果不相等则返回400
                // @ts-ignore - 保持与原代码相同的行为
                if (c.header[httpheader] != config.headers[httpheader]) return c.status = 400;
            }
            next();
        }, (c: KoaContext) => {
            let body = item.method === "get" ? JSON.parse(JSON.stringify(c.request.query)) : c.request.body;
            
            // 按照原代码格式输出日志
            for(const key in body) {
                logger.info(`{${key}} => ${body[key]}`);
            }
            
            // 如果配置了保存最新消息，则进行保存
            if (item.saveLatestMessage && body) {
                const message: StoredMessage = {
                    body: {...body},
                    timestamp: Date.now(),
                    path: path
                };
                
                // 更新内存中的消息
                latestMessages[path] = message;
                logger.info(`已保存来自 ${path} 的最新消息到内存`);
                
                // 如果配置了持久化，则保存到文件
                if (item.persistMessages) {
                    persistMessage(path, message, persistPath, logger);
                }
            }
            
            for (let bot of ctx.bots) {
                for (let rep of item.response) {
                    if (bot.platform != rep.platform && bot.selfId != rep.sid) {// 过滤机器人平台，用户名
                        continue;
                    }
                    sendResponseMsg(bot, rep.platform, rep, body ? body : {});
                    return c.status = 200;
                }
            }
            logger.error(`没有找到任何可发送的机器人,可用列表:[${ctx.bots.map((v: Bot) => `${v.platform},${v.selfId}`)}]`)
            return c.status = 405;
        });
    }
}