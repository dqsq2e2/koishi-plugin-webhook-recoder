import { Bot, Context, Logger, Schema } from 'koishi'
import type { Next } from 'koishi'
import type { Context as KoaContext } from 'koa'
import type { Session } from 'koishi'

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
}

export interface Config {
    [key: string]: Webhook
}

// 扩展Context接口，添加server属性
declare module 'koishi' {
    interface Context {
        server: {
            [method: string]: (path: string, ...middleware: any[]) => void
        }
    }
}

export const Config = Schema.dict(
    Schema.object({
        method: Schema.union(['get', 'post']).default('get').description('监听方式'),
        headers: Schema.dict(Schema.string()).role('table').description('检查头 如果填写则需要在请求头中包含'),
        response: Schema.array(Schema.object({
            platform: Schema.union(['onebot', 'kook', 'telegram', 'discord', 'lark', 'chronocat']).default('onebot').description('机器人平台'),
            sid: Schema.string().required().description('机器人id，用于获取Bot对象'),
            seeisonId: Schema.array(Schema.string().required()).role('table').description('群聊/私聊对象id,私聊对象需在前方加上`private:`,如`private:123456`'),
            msg: Schema.array(Schema.string().default("hello {name}.")).role('table').required().description('需要发送的信息，会使用换行符合并<br>接收的body会按照JSON解析，并将key以{key}形式全替换字符串内容')
        })).description('响应'),
        saveLatestMessage: Schema.boolean().default(false).description('是否保存最新消息'),
        customCommand: Schema.string().description('触发发送最新保存消息的指令，例如：/latest')
    })).description("监听指定路径，如:`/api`")


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
    const pathConfig = config[path];
    if (!pathConfig || !pathConfig.response) {
        return bot.createMessage(sessionId, `找不到 ${path} 的配置信息`);
    }
    
    // 查找匹配当前会话的响应配置
    for (const rep of pathConfig.response) {
        if (rep.seeisonId.includes(sessionId)) {
            // 使用相同的msg模板和替换逻辑
            sendResponseMsg(bot, rep.platform, rep, storedMessage.body);
            return;
        }
    }
    
    // 如果没有找到匹配的响应配置，使用保存的数据直接发送
    bot.createMessage(sessionId, `来自 ${path} 的最新消息：${JSON.stringify(storedMessage.body, null, 2)}`);
}

export function apply(ctx: Context, config: Config) {
    const logger = ctx.logger(name);

    // 注册自定义指令处理器
    for (let path in config) {
        const item = config[path];
        if (item.customCommand) {
            ctx.middleware((session: Session, next: Next) => {
                if (session.content === item.customCommand) {
                    // 找到匹配的机器人
                    for (let bot of ctx.bots) {
                        for (let rep of item.response) {
                            if (bot.platform === rep.platform && bot.selfId === rep.sid) {
                                // 检查会话是否在配置的会话ID列表中
                                const currentSessionId = session.guildId ? session.channelId : `private:${session.userId}`;
                                if (rep.seeisonId.includes(currentSessionId)) {
                                    sendLatestMessage(bot, currentSessionId, path, config);
                                    return;
                                }
                            }
                        }
                    }
                }
                return next();
            });
        }
    }

    for (let path in config) {
        let item = config[path];
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
                latestMessages[path] = {
                    body: {...body},
                    timestamp: Date.now(),
                    path: path
                };
                logger.info(`已保存来自 ${path} 的最新消息`);
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
