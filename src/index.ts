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

// 使用数组存储消息历史
const messageHistory: { [key: string]: StoredMessage[] } = {}

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
    instantForward?: boolean
    storeAllMessages?: boolean
    maxStoredMessages?: number
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
    persistMessages: Schema.boolean().default(false).description('是否将最新消息持久化保存到磁盘'),
    instantForward: Schema.boolean().default(true).description('是否在接收到webhook请求后立即转发'),
    storeAllMessages: Schema.boolean().default(false).description('是否存储所有接收到的消息历史记录'),
    maxStoredMessages: Schema.number().default(50).description('最大存储消息数量')
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

// 发送保存的消息
function sendStoredMessage(bot: Bot, sessionId: string, path: string, config: Config, messageIndex: number | string) {
    // 检查路径是否存在消息历史
    if (!messageHistory[path] || messageHistory[path].length === 0) {
        return bot.createMessage(sessionId, `暂无来自 ${path} 的消息记录`);
    }
    
    // 查找当前路径的配置
    const pathConfig = config[path] as Webhook | undefined;
    if (!pathConfig || !pathConfig.response) {
        return bot.createMessage(sessionId, `找不到 ${path} 的配置信息`);
    }
    
    // 处理消息索引
    let messagesToSend: Array<{message: StoredMessage, requestedIndex: number}> = [];
    let isRangeQuery = false;
    
    // 如果要发送所有消息
    if (messageIndex === 'all' || messageIndex === 'a') {
        // 获取所有消息，并保留其原始索引
        for (let i = 1; i <= messageHistory[path].length; i++) {
            const actualIndex = messageHistory[path].length - i;
            messagesToSend.push({
                message: messageHistory[path][actualIndex],
                requestedIndex: i
            });
        }
        isRangeQuery = true;
    } else if (typeof messageIndex === 'string' && messageIndex.includes('-')) {
        // 范围查询，如 "2-5"
        const [startStr, endStr] = messageIndex.split('-');
        const start = parseInt(startStr);
        const end = parseInt(endStr);
        
        if (isNaN(start) || isNaN(end) || start < 1 || end < start || end > messageHistory[path].length) {
            return bot.createMessage(sessionId, `无效的消息范围: ${messageIndex}，有效范围为 1-${messageHistory[path].length} 或 "all"`);
        }
        
        // 获取指定范围的消息（注意索引从1开始，1表示最新消息）
        for (let i = start; i <= end; i++) {
            const actualIndex = messageHistory[path].length - i;
            messagesToSend.push({
                message: messageHistory[path][actualIndex],
                requestedIndex: i
            });
        }
        isRangeQuery = true;
    } else {
        // 转换索引为数字（如果是字符串）
        let index = 1; // 默认为最新消息
        
        // 如果提供了具体索引
        if (messageIndex !== undefined && messageIndex !== '') {
            index = typeof messageIndex === 'number' ? messageIndex : parseInt(messageIndex as string);
        }
        
        // 索引从1开始，1表示最新消息
        if (isNaN(index) || index < 1 || index > messageHistory[path].length) {
            return bot.createMessage(sessionId, `无效的消息索引: ${messageIndex}，有效范围为 1-${messageHistory[path].length} 或 "all"`);
        }
        
        // 获取指定索引的消息（反向索引：1是最新的）
        const actualIndex = messageHistory[path].length - index;
        messagesToSend.push({
            message: messageHistory[path][actualIndex],
            requestedIndex: index
        });
        
        // 如果索引不是1（不是最新消息），则视为范围查询
        if (index !== 1) {
            isRangeQuery = true;
        }
    }
    
    // 如果没有消息要发送，返回错误
    if (messagesToSend.length === 0) {
        return bot.createMessage(sessionId, `暂无可发送的消息`);
    }
    
    // 查找匹配当前会话的响应配置
    let foundResponseConfig = false;
    for (const rep of pathConfig.response) {
        if (rep.seeisonId.includes(sessionId)) {
            foundResponseConfig = true;
            
            // 是否显示时间戳
            // 1. 范围查询总是显示时间戳
            // 2. 单条消息且非最新消息时显示时间戳
            // 3. 使用-n 1或-n（不带参数）时不显示时间戳
            const showTimestamp = isRangeQuery;
            
            // 如果是单条消息且不是范围查询，使用消息模板
            if (messagesToSend.length === 1 && !isRangeQuery) {
                // 不显示时间戳的情况 (最新消息)
                // 创建一个只包含当前会话ID的响应配置副本
                const singleSessionResponse: responseType = {
                    ...rep,
                    seeisonId: [sessionId]  // 只包含当前会话ID
                };
                
                // 发送单条消息，使用消息模板
                sendResponseMsg(bot, rep.platform, singleSessionResponse, messagesToSend[0].message.body);
            } else if (messagesToSend.length === 1) {
                // 单条非最新消息，显示带时间戳和索引的消息
                const msg = messagesToSend[0];
                const date = new Date(msg.message.timestamp);
                const timeStr = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
                
                // 使用用户请求的索引
                let formattedMsg = `来自 ${path} 的 1 条消息记录:\n\n`;
                formattedMsg += `[${msg.requestedIndex}] ${timeStr}\n`;
                
                // 使用消息模板
                let templateMsg = rep.msg.join("\n");
                for(const key in msg.message.body) {
                    templateMsg = templateMsg.replace(new RegExp(`{${key}}`, 'g'), msg.message.body[key]);
                }
                
                formattedMsg += templateMsg;
                bot.createMessage(sessionId, formattedMsg);
            } else {
                // 对于多条消息，构建一个格式化的消息列表
                let summaryMsg = `来自 ${path} 的 ${messagesToSend.length} 条消息记录:\n\n`;
                
                // 按照用户请求的索引顺序添加消息
                for (const msgObj of messagesToSend) {
                    // 添加时间戳，使用请求的原始索引作为显示索引
                    const date = new Date(msgObj.message.timestamp);
                    const timeStr = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
                    summaryMsg += `[${msgObj.requestedIndex}] ${timeStr}\n`;
                    
                    // 使用消息模板
                    let templateMsg = rep.msg.join("\n");
                    for(const key in msgObj.message.body) {
                        templateMsg = templateMsg.replace(new RegExp(`{${key}}`, 'g'), msgObj.message.body[key]);
                    }
                    
                    summaryMsg += templateMsg + "\n\n";
                }
                
                // 发送格式化后的摘要
                bot.createMessage(sessionId, summaryMsg);
            }
            return;
        }
    }
    
    // 如果没有找到匹配的响应配置，使用通用格式直接发送
    if (!foundResponseConfig) {
        // 是否显示时间戳
        const showTimestamp = isRangeQuery;
        
        if (messagesToSend.length === 1 && !showTimestamp) {
            // 不显示时间戳的单条消息(最新消息)
            bot.createMessage(sessionId, `来自 ${path} 的消息：${JSON.stringify(messagesToSend[0].message.body, null, 2)}`);
        } else if (messagesToSend.length === 1) {
            // 显示时间戳的单条消息，使用用户请求的索引
            const msgObj = messagesToSend[0];
            const date = new Date(msgObj.message.timestamp);
            const timeStr = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
            
            bot.createMessage(sessionId, `来自 ${path} 的 1 条消息记录:\n\n[${msgObj.requestedIndex}] ${timeStr}\n${JSON.stringify(msgObj.message.body, null, 2)}`);
        } else {
            // 多条消息，构建通用格式摘要，使用请求的原始索引
            let summaryMsg = `来自 ${path} 的 ${messagesToSend.length} 条消息记录:\n\n`;
            
            for (const msgObj of messagesToSend) {
                const date = new Date(msgObj.message.timestamp);
                const timeStr = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
                summaryMsg += `[${msgObj.requestedIndex}] ${timeStr}\n${JSON.stringify(msgObj.message.body, null, 2)}\n\n`;
            }
            
            bot.createMessage(sessionId, summaryMsg);
        }
    }
}

// 删除保存的消息
function deleteStoredMessages(bot: Bot, sessionId: string, path: string, deleteRange: string): string {
    // 检查路径是否存在消息历史
    if (!messageHistory[path] || messageHistory[path].length === 0) {
        return `暂无来自 ${path} 的消息记录可删除`;
    }
    
    // 处理删除范围
    if (deleteRange === 'all' || deleteRange === 'a') {
        // 删除所有消息
        const count = messageHistory[path].length;
        messageHistory[path] = [];
        return `已删除 ${path} 的所有 ${count} 条消息记录`;
    } else if (deleteRange === 'old' || deleteRange === 'o') {
        // 仅保留最新的一条消息
        if (messageHistory[path].length <= 1) {
            return `${path} 仅有一条消息记录，无需删除`;
        }
        
        const latestMessage = messageHistory[path][messageHistory[path].length - 1];
        const deletedCount = messageHistory[path].length - 1;
        messageHistory[path] = [latestMessage];
        return `已删除 ${path} 的 ${deletedCount} 条旧消息记录，保留最新消息`;
    } else if (deleteRange.includes('-')) {
        // 删除范围，如 "2-5"
        const [startStr, endStr] = deleteRange.split('-');
        const start = parseInt(startStr);
        const end = parseInt(endStr);
        
        if (isNaN(start) || isNaN(end) || start < 1 || end < start || end > messageHistory[path].length) {
            return `无效的删除范围: ${deleteRange}，有效范围为 1-${messageHistory[path].length}`;
        }
        
        // 计算反向索引（因为1是最新的消息）
        const reverseStart = messageHistory[path].length - end;
        const reverseEnd = messageHistory[path].length - start;
        
        // 删除指定范围的消息
        messageHistory[path].splice(reverseStart, reverseEnd - reverseStart + 1);
        return `已删除 ${path} 的第 ${start} 到第 ${end} 条消息记录`;
    } else {
        // 删除单条消息
        const index = parseInt(deleteRange);
        
        if (isNaN(index) || index < 1 || index > messageHistory[path].length) {
            return `无效的消息索引: ${deleteRange}，有效范围为 1-${messageHistory[path].length} 或 "all"`;
        }
        
        // 计算反向索引
        const reverseIndex = messageHistory[path].length - index;
        
        // 删除指定索引的消息
        messageHistory[path].splice(reverseIndex, 1);
        return `已删除 ${path} 的第 ${index} 条消息记录`;
    }
}

// 持久化保存消息到文件
function persistMessages(messagePath: string, persistPath: string, logger: Logger) {
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
        fs.writeFileSync(filePath, JSON.stringify(messageHistory[messagePath] || [], null, 2), 'utf8');
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
        const files = fs.readdirSync(dirPath).filter((file: string) => file.endsWith('.json'));
        logger.info(`找到 ${files.length} 个持久化消息文件`);
        
        // 加载每个文件的内容
        for (const file of files) {
            try {
                const filePath = path.join(dirPath, file);
                const content = fs.readFileSync(filePath, 'utf8');
                const messages = JSON.parse(content) as StoredMessage[];
                
                if (Array.isArray(messages) && messages.length > 0) {
                    // 从第一条消息获取路径
                    const originalPath = messages[0].path;
                    messageHistory[originalPath] = messages;
                    logger.info(`已加载来自 ${originalPath} 的 ${messages.length} 条持久化消息`);
                } else if (!Array.isArray(messages) && 'body' in messages && 'path' in messages) {
                    // 兼容旧格式（单条消息）
                    const message = messages as any as StoredMessage;
                    const originalPath = message.path;
                    messageHistory[originalPath] = [message];
                    logger.info(`已加载来自 ${originalPath} 的 1 条旧格式持久化消息`);
                }
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
    
    // 检查每个路径的配置，如果storeAllMessages为false，则只保留每个路径的最新消息
    for (let path in messageHistory) {
        const pathConfig = config[path] as Webhook | undefined;
        
        // 如果配置存在且storeAllMessages为false
        if (pathConfig && pathConfig.storeAllMessages === false && messageHistory[path].length > 1) {
            // 只保留最新的一条消息
            const latestMessage = messageHistory[path][messageHistory[path].length - 1];
            messageHistory[path] = [latestMessage];
            logger.info(`配置 ${path} 未开启storeAllMessages，仅保留最新消息，已删除 ${messageHistory[path].length - 1} 条历史消息`);
            
            // 如果配置了持久化，保存更改
            if (pathConfig.persistMessages) {
                persistMessages(path, persistPath, logger);
            }
        }
    }

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
                .option('number', '-n <number>', { fallback: '1' })
                .option('delete', '-d <range>')
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
                    
                    // 查找路径对应的配置
                    const targetConfig = config[targetPath] as Webhook | undefined;
                    if (!targetConfig) {
                        return `找不到路径 ${targetPath} 的配置信息`;
                    }
                    
                    // 检查命令选项，判断是否使用了-n选项
                    // 通过检查number是否不等于默认值，可判断用户是否指定了-n选项
                    const defaultNumberValue = '1'; // 与选项定义中的fallback值一致
                    const userSpecifiedNumber = options && options.number !== undefined && options.number !== defaultNumberValue;
                    
                    // 检查是否使用了-d选项
                    const userSpecifiedDelete = options && 'delete' in options;
                    
                    // 如果用户指定了非默认值的-n选项或-d选项，但未开启storeAllMessages
                    if ((userSpecifiedNumber || userSpecifiedDelete) && targetConfig.storeAllMessages !== true) {
                        return `路径 ${targetPath} 未开启存储所有消息功能(storeAllMessages)，不能使用 -n 或 -d 选项操作消息`;
                    }
                    
                    // 另一种检查：通过原始命令文本检查是否包含-n或-d选项
                    const commandLine = session?.content || '';
                    if ((commandLine.includes(' -n ') || commandLine.includes(' --number ') || 
                         commandLine.endsWith(' -n') || commandLine.endsWith(' --number') ||
                         commandLine.includes(' -d ') || commandLine.includes(' --delete ') ||
                         commandLine.endsWith(' -d') || commandLine.endsWith(' --delete')) && 
                        targetConfig.storeAllMessages !== true) {
                        return `路径 ${targetPath} 未开启存储所有消息功能(storeAllMessages)，不能使用 -n 或 -d 选项操作消息`;
                    }
                    
                    // 找到匹配的机器人
                    const botId = `${session.platform}:${session.selfId}`;
                    const bot = ctx.bots[botId];
                    if (!bot) {
                        return `找不到匹配的机器人: ${botId}`;
                    }
                    
                    // 如果指定了删除选项
                    if (options?.delete) {
                        const result = deleteStoredMessages(bot, currentSessionId, targetPath, options.delete);
                        
                        // 如果配置了持久化，则保存更改后的消息
                        if (item.persistMessages) {
                            persistMessages(targetPath, persistPath, logger);
                        }
                        
                        return result;
                    }
                    
                    // 发送消息（默认为最新消息，索引1）
                    sendStoredMessage(bot, currentSessionId, targetPath, config, options?.number || '1');
                });
        }
    }

    // 使用ctx.intersect注册一个只对特定平台可用的指令
    // 例如，只对onebot平台可用的webhook-latest指令
    ctx.intersect(session => session.platform === 'onebot')
        .command('webhook-latest [path]', '获取指定Webhook路径的最新消息')
        .option('number', '-n <number>', { fallback: '1' })
        .option('delete', '-d <range>')
        .action(async ({ session, options }, path) => {
            if (!session) return '无法获取会话信息';
            
            if (!path) {
                // 如果没有指定路径，列出所有可用的路径
                const paths = Object.keys(messageHistory);
                if (paths.length === 0) {
                    return '目前没有任何保存的消息';
                }
                return `可用的Webhook路径: ${paths.join(', ')}`;
            }
            
            // 查找路径对应的配置
            const pathConfig = config[path] as Webhook | undefined;
            if (!pathConfig) {
                return `找不到路径 ${path} 的配置信息`;
            }
            
            // 检查命令选项，判断是否使用了-n选项
            // 通过检查number是否不等于默认值，可判断用户是否指定了-n选项
            const defaultNumberValue = '1'; // 与选项定义中的fallback值一致
            const userSpecifiedNumber = options && options.number !== undefined && options.number !== defaultNumberValue;
            
            // 检查是否使用了-d选项
            const userSpecifiedDelete = options && 'delete' in options;
            
            // 如果用户指定了非默认值的-n选项或-d选项，但未开启storeAllMessages
            if ((userSpecifiedNumber || userSpecifiedDelete) && pathConfig.storeAllMessages !== true) {
                return `路径 ${path} 未开启存储所有消息功能(storeAllMessages)，不能使用 -n 或 -d 选项操作消息`;
            }
            
            // 另一种检查：通过原始命令文本检查是否包含-n或-d选项
            const commandLine = session?.content || '';
            if ((commandLine.includes(' -n ') || commandLine.includes(' --number ') || 
                 commandLine.endsWith(' -n') || commandLine.endsWith(' --number') ||
                 commandLine.includes(' -d ') || commandLine.includes(' --delete ') ||
                 commandLine.endsWith(' -d') || commandLine.endsWith(' --delete')) && 
                pathConfig.storeAllMessages !== true) {
                return `路径 ${path} 未开启存储所有消息功能(storeAllMessages)，不能使用 -n 或 -d 选项操作消息`;
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
            
            // 如果指定了删除选项
            if (options?.delete) {
                const result = deleteStoredMessages(bot, currentSessionId, path, options.delete);
                
                // 如果配置了持久化，检查该路径的配置
                if (pathConfig && pathConfig.persistMessages) {
                    persistMessages(path, persistPath, logger);
                }
                
                return result;
            }
            
            // 发送消息
            sendStoredMessage(bot, currentSessionId, path, config, options?.number || '1');
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
            
            // 如果配置了保存消息
            if (item.saveLatestMessage && body) {
                const message: StoredMessage = {
                    body: {...body},
                    timestamp: Date.now(),
                    path: path
                };
                
                // 初始化消息历史数组（如果不存在）
                if (!messageHistory[path]) {
                    messageHistory[path] = [];
                }
                
                // 根据配置决定存储方式
                if (item.storeAllMessages) {
                    // 添加新消息到历史记录中
                    messageHistory[path].push(message);
                    
                    // 检查是否超过最大消息数量
                    const maxMessages = item.maxStoredMessages || 50;
                    if (messageHistory[path].length > maxMessages) {
                        // 移除最旧的消息，保持最大数量
                        messageHistory[path] = messageHistory[path].slice(-maxMessages);
                    }
                    
                    logger.info(`已保存来自 ${path} 的消息到历史记录，当前共 ${messageHistory[path].length} 条`);
                } else {
                    // 仅保存最新消息
                    messageHistory[path] = [message];
                    logger.info(`已更新来自 ${path} 的最新消息`);
                }
                
                // 如果配置了持久化，则保存到文件
                if (item.persistMessages) {
                    persistMessages(path, persistPath, logger);
                }
            }
            
            // 只有在开启即时转发（默认为true）时才转发消息
            if (item.instantForward !== false) {
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
            } else {
                logger.info(`接收到来自 ${path} 的请求，但未开启即时转发`);
                return c.status = 200;
            }
        });
    }
}