import { Context } from "hono";
import { DB, Notice, Post, Thread, User } from "./data";
import { Auth, Cache, Counter, HTMLFilter, HTMLSubject, Status } from "./base";
import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm";

export async function pSave(a: Context) {
    const i = await Auth(a)
    if (!i) { return a.text('401', 401) }
    const time = Math.floor(Date.now() / 1000)
    const body = await a.req.formData()
    const eid = parseInt(a.req.param('eid') ?? '0')
    if (eid < 0) { // 编辑
        const content = HTMLFilter(body.get('content')?.toString() ?? '')
        if (!content) { return a.text('406', 406) }
        const post = (await DB
            .update(Post)
            .set({
                content: content,
            })
            .where(and(
                eq(Post.pid, -eid),
                eq(Post.access, 0),
                [1].includes(i.gid) ? undefined : eq(Post.uid, i.uid), // 只有作者可以编辑
                [1].includes(i.gid) ? undefined : gt(sql`${Post.create_date} + 604800`, time), // 7天后禁止编辑
            ))
            .returning()
        )?.[0]
        if (!post) { return a.text('403', 403) }
        if (!post.tid) {
            await DB
                .update(Thread)
                .set({
                    subject: HTMLSubject(content, 140),
                })
                .where(eq(Thread.tid, post.pid))
        }
        return a.text('ok')
    } else if (eid > 0) { // 回复
        if (time - (Cache.get(-i.uid) ?? 0) < 60) { return a.text('too_fast', 403) }
        const post = (await DB
            .select()
            .from(Post)
            .where(and(
                eq(Post.pid, eid),
                eq(Post.access, 0),
            ))
        )?.[0]
        if (!post) { return a.text('403', 403) }
        const content = HTMLFilter(body.get('content')?.toString() ?? '')
        if (!content) { return a.text('406', 406) }
        const thread = (await DB
            .update(Thread)
            .set({
                posts: sql`${Thread.posts}+1`,
                last_uid: i.uid,
                last_date: time,
            })
            .where(and(
                eq(Thread.tid, post.tid ? post.tid : post.pid),
                gt(sql`${Thread.last_date} + 604800`, time),
            ))
            .returning()
        )?.[0]
        // 帖子找不到 一周没有热度 禁止回复
        if (!thread) { return a.text('403', 403) }
        const reply = (await DB
            .insert(Post)
            .values({
                tid: post.tid ? post.tid : post.pid,
                uid: i.uid,
                create_date: time,
                quote_pid: eid, // 直接使用被回复帖子的 pid
                quote_uid: post.uid,
                content: content,
            })
            .returning()
        )?.[0]
        await DB
            .update(User)
            .set({
                posts: sql`${User.posts} + 1`,
                credits: sql`${User.credits} + 1`,
                golds: sql`${User.golds} + 1`,
            })
            .where(eq(User.uid, reply.uid))
        Counter.add(0, thread.tid); // 帖子回复+1
        Counter.add(reply.uid, thread.tid); // 用户帖子回复+1
        // 回复通知 Notice 开始
        // [通知]有回复所在的Thread 则更新自己的回帖
        await DB
            .update(Notice)
            .set({
                last_pid: reply.pid,
                read_pid: sql`CASE WHEN ${Notice.last_pid} = ${Notice.read_pid} THEN ${reply.pid} ELSE ${Notice.read_pid} END`,
            })
            .where(and(
                eq(Notice.tid, reply.tid),
                eq(Notice.uid, reply.uid), // 查找回帖人自己的uid
            ))
        // 给回复目标的[通知]增加提醒
        if (post.uid != reply.uid) {
            await updateNotice(reply.tid, reply.quote_uid, reply.pid)
            Status(post.uid, 1)
        }
        // 回复通知 Notice 结束
        Cache.set(-i.uid, time)
        Status(i.uid, 10)
        return a.text('ok') //! 返回tid/pid和posts数量
    } else { // 发帖
        if (time - (Cache.get(-i.uid) ?? 0) < 60) { return a.text('too_fast', 403) }
        const content = HTMLFilter(body.get('content')?.toString() ?? '')
        if (!content) { return a.text('406', 406) }
        const post = (await DB
            .insert(Post)
            .values({
                uid: i.uid,
                create_date: time,
                content: content,
            })
            .returning()
        )?.[0]
        await DB
            .insert(Thread)
            .values({
                tid: post.pid,
                uid: i.uid,
                subject: HTMLSubject(content, 140),
                create_date: time,
                last_date: time,
                posts: 1,
            })
        await DB
            .update(User)
            .set({
                threads: sql`${User.threads} + 1`,
                posts: sql`${User.posts} + 1`,
                credits: sql`${User.credits} + 2`,
                golds: sql`${User.golds} + 2`,
            })
            .where(eq(User.uid, i.uid))
        Counter.add(0, 0); // 全局发帖+1
        Counter.add(i.uid, 0); // 用户发帖+1
        Cache.set(-i.uid, time)
        Status(i.uid, 10)
        return a.text(String(post.pid))
    }
}

export async function pOmit(a: Context) {
    const i = await Auth(a)
    if (!i) { return a.text('401', 401) }
    const pid = -parseInt(a.req.param('eid') ?? '0')
    
    let post;  // 声明post变量在外部作用域

    // 检查用户权限
    if (i.gid !== 1) {
        // 非管理员只能删除自己的帖子
        post = (await DB
            .update(Post)
            .set({
                access: 3,
            })
            .where(and(
                eq(Post.pid, pid),
                eq(Post.uid, i.uid), // 普通用户只能删除自己的帖子
            ))
            .returning()
        )?.[0]
        if (!post) { return a.text('410:gone', 410) }
    } else {
        // 管理员可以删除任何帖子
        post = (await DB
            .update(Post)
            .set({
                access: 3,
            })
            .where(eq(Post.pid, pid))
            .returning()
        )?.[0]
        if (!post) { return a.text('410:gone', 410) }
    }

    if (post.tid) {
        // 如果删的是Post
        const last = (await DB
            .select()
            .from(Post)
            .where(and(
                // access
                eq(Post.access, 0),
                // tid - pid
                or(
                    and(eq(Post.tid, 0), eq(Post.pid, post.tid)),
                    eq(Post.tid, post.tid),
                ),
            ))
            .orderBy(desc(Post.pid))
            .limit(1)
        )?.[0]
        await DB
            .update(Thread)
            .set({
                posts: sql`${Thread.posts} - 1`,
                last_uid: last.tid ? last.uid : 0,
                last_date: last.create_date,
            })
            .where(eq(Thread.tid, post.tid))
        await DB
            .update(User)
            .set({
                posts: sql`${User.posts} - 1`,
                credits: sql`${User.credits} - 1`,
                golds: sql`${User.golds} - 1`,
            })
            .where(eq(User.uid, post.uid))
        Counter.sub(0, post.tid); // 帖子回复-1
        Counter.sub(post.uid, post.tid); // 用户帖子回复-1
        // 历史提醒（用户自己）
        const post_u = (await DB
            .select()
            .from(Post)
            .where(and(
                // access
                eq(Post.access, 0),
                // uid | quote_uid
                or(eq(Post.uid, post.uid), eq(Post.quote_uid, post.uid)),
                // tid - pid
                or(
                    and(eq(Post.tid, 0), eq(Post.pid, post.tid)),
                    and(eq(Post.tid, post.tid), lt(Post.pid, pid)),
                ),
            ))
            .orderBy(desc(Post.pid))
            .limit(1)
        )?.[0]
        if (post.tid && post_u) {
            // 如果有则跳回上一条提醒
            await DB
                .update(Notice)
                .set({
                    last_pid: post_u.pid,
                    unread: sql`CASE WHEN ${Notice.read_pid} < ${post_u.pid} THEN 1 ELSE 0 END`,
                })
                .where(and(
                    eq(Notice.tid, post.tid || post.pid),
                    eq(Notice.uid, post.uid),
                    eq(Notice.last_pid, post.pid),
                ))
        } else {
            await DB
                .delete(Notice)
                .where(and(
                    eq(Notice.tid, post.tid || post.pid),
                    eq(Notice.uid, post.uid),
                ))
        }
        Status(post.uid, null)
        // 历史提醒（被回复人）
        const post_q = (await DB
            .select()
            .from(Post)
            .where(and(
                // access
                eq(Post.access, 0),
                // uid | quote_uid
                or(eq(Post.uid, post.quote_uid), eq(Post.quote_uid, post.quote_uid)),
                // tid - pid
                or(
                    and(eq(Post.tid, 0), eq(Post.pid, post.tid)),
                    and(eq(Post.tid, post.tid), lt(Post.pid, pid))
                ),
            ))
            .orderBy(desc(Post.pid))
            .limit(1)
        )?.[0]
        if (post.tid && post_q) {
            // 如果有则跳回上一条提醒
            await DB
                .update(Notice)
                .set({
                    last_pid: post_q.pid,
                    unread: sql`CASE WHEN ${Notice.read_pid} < ${post_q.pid} THEN 1 ELSE 0 END`,
                })
                .where(and(
                    eq(Notice.tid, post.tid || post.pid),
                    eq(Notice.uid, post.quote_uid),
                    eq(Notice.last_pid, post.pid),
                ))
        } else {
            await DB
                .delete(Notice)
                .where(and(
                    eq(Notice.tid, post.tid || post.pid),
                    eq(Notice.uid, post.quote_uid),
                ))
        }
        Status(post.quote_uid, null)
    } else {
        // 如果删的是Thread
        await DB
            .update(Thread)
            .set({
                access: 3,
            })
            .where(and(
                eq(Thread.tid, post.pid),
                [1].includes(i.gid) ? undefined : eq(Thread.uid, i.uid), // 管理和作者都能删除
            ))
        await DB
            .update(User)
            .set({
                threads: sql`${User.threads} - 1`,
                posts: sql`${User.posts} - 1`,
                credits: sql`${User.credits} - 2`,
                golds: sql`${User.golds} - 2`,
            })
            .where(eq(User.uid, post.uid))
        Counter.sub(0, 0); // 全局发帖-1
        Counter.sub(post.uid, 0); // 用户发帖-1
        const noticeUidArr = (await DB
            .delete(Notice)
            .where(and(
                eq(Notice.tid, post.tid || post.pid),
            ))
            .returning({ uid: Notice.uid })
        )
        noticeUidArr.forEach(function (row) {
            Status(row.uid, null)
        })
    }
    return a.text('ok')
}

async function updateNotice(tid: number, uid: number, pid: number) {
    try {
        // 先查询是否存在通知
        const existingNotice = await DB
            .select()
            .from(Notice)
            .where(and(
                eq(Notice.tid, tid),
                eq(Notice.uid, uid)
            ))
            .execute();

        if (existingNotice.length > 0) {
            // 如果存在，更新
            await DB.update(Notice)
                .set({
                    last_pid: pid,
                    unread: 1
                })
                .where(and(
                    eq(Notice.tid, tid),
                    eq(Notice.uid, uid)
                ))
                .execute();
        } else {
            // 如果不存在，插入新记录
            await DB.insert(Notice)
                .values({
                    tid,
                    uid,
                    last_pid: pid,
                    read_pid: 0,
                    unread: 1
                })
                .execute();
        }
    } catch (error) {
        console.error('更新通知失败:', error);
        // 不抛出错误，避免影响主流程
    }
}