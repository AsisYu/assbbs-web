import { Context } from "hono";
import { html } from "hono/html";
import { deleteCookie } from "hono/cookie";
import { eq, sql } from "drizzle-orm";
import { DB, Post, Thread, User } from "./base";
import { Auth, Counter } from "./core";
import * as DOMPurify from 'isomorphic-dompurify';

export async function pEditPost(a: Context) {
    const i = await Auth(a)
    if (!i) { return a.text('401', 401) }
    const time = Math.floor(Date.now() / 1000)
    const body = await a.req.formData()
    const id = parseInt(a.req.param('id') ?? '0')
    if (id < 0) {
        const post = (await DB
            .select()
            .from(Post)
            .where(eq(Post.pid, -id))
        )?.[0]
        //! 转换为 AllowEdit 函数
        if (!post || post.uid != i.uid) { return a.text('401', 401) }
        const content = DOMPurify.sanitize(body.get('content')?.toString() ?? '')
        if (!content) { return a.text('422', 422) }
        await DB
            .update(Post)
            .set({ message_fmt: content })
            .where(eq(Post.pid, post.pid))
        if (!post.tid) {
            const subject = html`${body.get('subject')?.toString() ?? ''}`.toString()
            if (!subject) { return a.text('422', 422) }
            await DB.update(Thread)
                .set({ subject: subject })
                .where(eq(Thread.tid, post.pid))
        }
        return a.text('ok')
    } else if (id > 0) {
        const post = (await DB
            .select()
            .from(Post)
            .where(eq(Post.pid, id))
        )?.[0]
        if (!post) { return a.text('401', 401) }
        const content = DOMPurify.sanitize(body.get('content')?.toString() ?? '')
        if (!content) { return a.text('422', 422) }
        await DB
            .insert(Post)
            .values({
                tid: post.tid ? post.tid : post.pid,
                uid: i.uid as number,
                create_date: time,
                quotepid: post.tid ? post.pid : 0,
                message_fmt: content,
            })
        await DB
            .update(Thread)
            .set({ posts: sql`${Thread.posts}+1`, last_date: time, lastuid: i.uid as number }) //! 太老的帖子不更新时间
            .where(eq(Thread.tid, post.tid ? post.tid : post.pid))
        await DB
            .update(User)
            .set({ posts: sql`${User.posts} + 1` })
            .where(eq(User.uid, i.uid as number))
        return a.text('ok') //! 返回tid/pid和posts数量
    } else {
        const subject = html`${body.get('subject')?.toString() ?? ''}`.toString()
        if (!subject) { return a.text('422', 422) }
        const content = DOMPurify.sanitize(body.get('content')?.toString() ?? '')
        if (!content) { return a.text('422', 422) }
        const post = (await DB
            .insert(Post)
            .values({
                uid: i.uid as number,
                create_date: time,
                message_fmt: content,
            })
            .returning({ pid: Post.pid })
        )?.[0]
        await DB
            .insert(Thread)
            .values({
                tid: post.pid,
                uid: i.uid as number,
                subject: subject,
                create_date: time,
                last_date: time,
                posts: 1,
                lastuid: i.uid as number,
            })
        await DB
            .update(User)
            .set({ threads: sql`${User.threads} + 1`, posts: sql`${User.posts} + 1` })
            .where(eq(User.uid, i.uid as number))
        new Counter('T').add()
        return a.text(String(post.pid))
    }
}

export async function iLogoutPost(a: Context) {
    deleteCookie(a, 'JWT')
    return a.text('ok')
}
