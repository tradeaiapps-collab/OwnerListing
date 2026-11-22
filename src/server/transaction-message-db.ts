import { randomUUID } from "node:crypto";
import { CHANNEL_ACCESS, isChannel, mayUseChannel, mentionedRoles, MAX_PER_MINUTE, snippet, threadTitle, type Channel, type Role, type SendInput } from "../domain/transaction-messages";
import { createPgContentFlagStore } from "./content-flag-db";
import { guardContent } from "./content-guard";
import type { Queryable } from "./db";
import { notifyUser } from "./notifier";

// Parameterised SQL only. Messages are append-only (db trigger). Who may read or write is worked out from the settlement row, never from the request.

export type Out<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/** Staff are passed as their permission list; ordinary people as null. Staff see channels; deal threads are for the people in the deal. */
export type Viewer = { staffPermissions: readonly string[] | null };
const PERSON: Viewer = { staffPermissions: null };

interface Thread {
  id: string; kind: "transaction" | "channel"; title: string; listing: string; role: Role | "staff"; archived: boolean; muted: boolean; lastReadAt: string;
  people: { role: Role; userId: string; name: string }[];
}

/** Makes sure the settlement's thread exists. Its id is the settlement id. */
export async function ensureTransactionThread(tx: Queryable, settlementId: string): Promise<void> {
  await tx.query("INSERT INTO message_threads (id, kind, settlement_id) VALUES ($1::uuid, 'transaction', $1::uuid) ON CONFLICT DO NOTHING", [settlementId]);
}

/** The caller's seat in a thread, or null. A person who is both buyer and owner has no seat. Channels need the staff permission for that channel. */
async function access(tx: Queryable, userId: string, id: string, viewer: Viewer = PERSON): Promise<Thread | null> {
  const th = (await tx.query(
    `SELECT t.kind, t.channel, s.archived_at, COALESCE(p.muted, false) AS muted, COALESCE(p.last_read_at, 'epoch') AS last_read_at
       FROM message_threads t LEFT JOIN thread_settings s ON s.thread_id = t.id
       LEFT JOIN message_participants p ON p.thread_id = t.id AND p.user_id = $1::uuid WHERE t.id = $2::uuid`, [userId, id])).rows[0];
  if (!th) {
    // A settlement that predates messaging gets its thread the first time a party opens it.
    if (!(await tx.query("SELECT 1 FROM settlement_timeline WHERE id = $1::uuid", [id])).rows.length) return null;
    await ensureTransactionThread(tx, id);
    return access(tx, userId, id, viewer);
  }
  const base = { id, archived: th["archived_at"] != null, muted: Boolean(th["muted"]), lastReadAt: iso(th["last_read_at"]) };
  if (th["kind"] === "channel") {
    const c = String(th["channel"]);
    if (!viewer.staffPermissions || !isChannel(c) || !mayUseChannel(c, viewer.staffPermissions)) return null;
    return { ...base, kind: "channel", title: CHANNEL_ACCESS[c].label, listing: CHANNEL_ACCESS[c].label, role: "staff", archived: false, people: [] };
  }
  const r = (await tx.query(
    `SELECT t.buyer_id, t.seller_id, l.title, bu.display_name AS buyer_name, su.display_name AS seller_name,
            COALESCE((SELECT a.agent_user_id FROM listing_agent_appointment a WHERE a.listing_id = t.listing_id AND a.revoked_at IS NULL LIMIT 1), t.agent_id) AS agent_id
       FROM settlement_timeline t JOIN property_listing l ON l.id = t.listing_id
       JOIN app_user bu ON bu.id = t.buyer_id JOIN app_user su ON su.id = t.seller_id WHERE t.id = $1::uuid`, [id])).rows[0];
  if (!r || String(r["buyer_id"]) === String(r["seller_id"])) return null;
  const people: Thread["people"] = [
    { role: "buyer", userId: String(r["buyer_id"]), name: String(r["buyer_name"]) },
    { role: "seller", userId: String(r["seller_id"]), name: String(r["seller_name"]) }
  ];
  if (r["agent_id"]) {
    const a = (await tx.query("SELECT display_name FROM app_user WHERE id = $1::uuid", [r["agent_id"]])).rows[0];
    people.push({ role: "agent", userId: String(r["agent_id"]), name: String(a?.["display_name"] ?? "Agent") });
  }
  const me = people.find(p => p.userId === userId);
  if (!me) return null;
  return { ...base, kind: "transaction", title: threadTitle(String(r["title"]), String(r["buyer_name"])), listing: String(r["title"]), role: me.role, people };
}

export interface MessageView {
  id: string; type: "text" | "mention" | "system"; body: string; mentions: Role[]; createdAt: string; mine: boolean; unread: boolean;
  sender: { name: string; role: Role | null } | null; replyTo: { id: string; snippet: string; senderName: string | null } | null;
}
export interface ThreadView { id: string; kind: "transaction" | "channel"; title: string; role: Role | "staff"; archived: boolean; muted: boolean; people: { role: Role; name: string }[]; messages: MessageView[]; unread: number }

export async function threadMessages(db: Queryable, userId: string, id: string, viewer: Viewer = PERSON): Promise<Out<ThreadView>> {
  const t = await access(db, userId, id, viewer);
  if (!t) return no(404, "Conversation not found.");
  const rows = (await db.query(
    `SELECT * FROM (SELECT m.id, m.sender_id, m.message_type, m.body, m.mentions, m.created_at, m.reply_to_id,
            r.body AS reply_body, ru.display_name AS reply_name
       FROM transaction_messages m LEFT JOIN transaction_messages r ON r.id = m.reply_to_id LEFT JOIN app_user ru ON ru.id = r.sender_id
      WHERE m.thread_id = $1::uuid ORDER BY m.created_at DESC, m.id DESC LIMIT 500) x ORDER BY x.created_at, x.id`, [id])).rows;
  const byId = new Map(t.people.map(p => [p.userId, p]));
  const names = t.kind === "channel" ? new Map((await db.query("SELECT id, display_name FROM app_user WHERE id = ANY($1::uuid[])", [[...new Set(rows.map(r => String(r["sender_id"] ?? "")).filter(Boolean))]])).rows.map(u => [String(u["id"]), String(u["display_name"])])) : null;
  const messages = rows.map((r): MessageView => {
    const sid = r["sender_id"] ? String(r["sender_id"]) : null, from = sid ? byId.get(sid) : undefined;
    return {
      id: String(r["id"]), type: String(r["message_type"]) as MessageView["type"], body: String(r["body"]), mentions: (r["mentions"] as Role[]) ?? [], createdAt: iso(r["created_at"]),
      mine: sid === userId, unread: sid !== userId && iso(r["created_at"]) > t.lastReadAt,
      sender: sid ? { name: from?.name ?? names?.get(sid) ?? "Former participant", role: from?.role ?? null } : null,
      replyTo: r["reply_to_id"] ? { id: String(r["reply_to_id"]), snippet: snippet(String(r["reply_body"] ?? "")), senderName: r["reply_name"] ? String(r["reply_name"]) : null } : null
    };
  });
  return { ok: true, value: { id, kind: t.kind, title: t.title, role: t.role, archived: t.archived, muted: t.muted, people: t.people.map(p => ({ role: p.role, name: p.name })), messages, unread: messages.filter(m => m.unread).length } };
}

export async function markRead(db: Queryable, userId: string, id: string, viewer: Viewer = PERSON): Promise<Out<{ read: true }>> {
  const t = await access(db, userId, id, viewer);
  if (!t) return no(404, "Conversation not found.");
  await db.query(
    `INSERT INTO message_participants (thread_id, user_id, last_read_at) VALUES ($1::uuid, $2::uuid, clock_timestamp())
     ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_at = clock_timestamp()`, [id, userId]);
  return { ok: true, value: { read: true } };
}

export async function setMuted(db: Queryable, userId: string, id: string, muted: boolean, viewer: Viewer = PERSON): Promise<Out<{ muted: boolean }>> {
  const t = await access(db, userId, id, viewer);
  if (!t) return no(404, "Conversation not found.");
  await db.query(
    `INSERT INTO message_participants (thread_id, user_id, muted) VALUES ($1::uuid, $2::uuid, $3)
     ON CONFLICT (thread_id, user_id) DO UPDATE SET muted = $3`, [id, userId, muted]);
  return { ok: true, value: { muted } };
}

/** Any of the three people can archive or reopen the thread. Archived threads stay readable but take no new messages. */
export async function setArchived(db: Queryable, userId: string, id: string, archived: boolean, viewer: Viewer = PERSON): Promise<Out<{ archived: boolean }>> {
  const t = await access(db, userId, id, viewer);
  if (!t) return no(404, "Conversation not found.");
  if (t.kind === "channel") return no(409, "Team channels cannot be archived.");
  await db.query(
    `INSERT INTO thread_settings (thread_id, archived_at, archived_by) VALUES ($1::uuid, CASE WHEN $3 THEN now() END, CASE WHEN $3 THEN $2::uuid END)
     ON CONFLICT (thread_id) DO UPDATE SET archived_at = CASE WHEN $3 THEN now() END, archived_by = CASE WHEN $3 THEN $2::uuid END`, [id, userId, archived]);
  return { ok: true, value: { archived } };
}

/**
 * Posts a message. The other people are told by email/in-app/push on their own notification settings, unless they muted the thread:
 * anyone @mentioned is always told; the rest only when they had nothing unread, so a busy thread is one alert until they catch up.
 */
export async function sendMessage(db: Queryable, userId: string, id: string, input: SendInput, env: Readonly<Record<string, string | undefined>> = process.env, viewer: Viewer = PERSON): Promise<Out<{ id: string }>> {
  // Abuse is refused and spam is flagged for staff. Contact details are not checked here: once an offer is accepted the parties are put in touch.
  const guard = await guardContent(createPgContentFlagStore(db), { source: "message", subjectType: "deal_message", userId, fields: { body: input.body }, ignore: ["contact_details"] });
  if (!guard.ok) return no(422, guard.message);
  const done = await atomic(db, async tx => {
    const t = await access(tx, userId, id, viewer);
    if (!t) return no(404, "Conversation not found.");
    if (t.archived) return no(409, "This conversation is archived. Reopen it to write.");
    if (Number((await tx.query("SELECT count(*) AS n FROM transaction_messages WHERE sender_id = $1::uuid AND created_at > now() - interval '1 minute'", [userId])).rows[0]?.["n"]) >= MAX_PER_MINUTE)
      return no(429, "You are sending messages very quickly. Wait a moment.");
    if (input.replyToId && !(await tx.query("SELECT 1 FROM transaction_messages WHERE id = $1::uuid AND thread_id = $2::uuid", [input.replyToId, id])).rows.length) return no(404, "The message you are replying to was not found.");
    const roles = t.kind === "channel" ? [] : mentionedRoles(input.body).filter(r => r !== t.role && t.people.some(p => p.role === r));
    const others = t.people.filter(p => p.userId !== userId);
    const state = (await tx.query(
      `SELECT u.user_id, COALESCE(p.muted, false) AS muted,
              (SELECT count(*) FROM transaction_messages m WHERE m.thread_id = $1::uuid AND m.message_type <> 'system' AND m.sender_id IS DISTINCT FROM u.user_id AND m.created_at > COALESCE(p.last_read_at, 'epoch')) AS unread
         FROM unnest($2::uuid[]) AS u(user_id) LEFT JOIN message_participants p ON p.thread_id = $1::uuid AND p.user_id = u.user_id`,
      [id, others.map(o => o.userId)])).rows;
    const msgId = randomUUID();
    await tx.query(
      "INSERT INTO transaction_messages (id, thread_id, sender_id, message_type, body, mentions, reply_to_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::text[],$7)",
      [msgId, id, userId, roles.length ? "mention" : "text", input.body, roles, input.replyToId]);
    await tx.query(
      `INSERT INTO message_participants (thread_id, user_id, last_read_at) VALUES ($1::uuid, $2::uuid, clock_timestamp())
       ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_at = clock_timestamp()`, [id, userId]);
    const tell = t.kind === "channel" ? [] : others.filter(o => {
      const s = state.find(x => String(x["user_id"]) === o.userId);
      return !s?.["muted"] && (roles.includes(o.role) || Number(s?.["unread"] ?? 0) === 0);
    });
    return { ok: true as const, value: { id: msgId }, tell, sender: t.people.find(p => p.userId === userId)?.name ?? "Team", listing: t.listing };
  });
  if (!done.ok) return done;
  await guard.after(done.value.id);
  // After the commit, and never allowed to fail the send (notifyUser does not throw).
  await Promise.all(done.tell.map(o => notifyUser(db, o.userId, "message_received", { name: done.sender, listing: done.listing, link: `/settlements/${id}/messages` }, env)));
  return { ok: true, value: done.value };
}

/** A line from the platform itself, such as a stage change. Runs inside the caller's transaction so it commits or rolls back with the change it reports. */
export async function postSystemNote(tx: Queryable, settlementId: string, body: string, mentions: Role[] = []): Promise<void> {
  await ensureTransactionThread(tx, settlementId);
  await tx.query("INSERT INTO transaction_messages (id, thread_id, sender_id, message_type, body, mentions) VALUES ($1::uuid,$2::uuid,NULL,'system',$3,$4::text[])", [randomUUID(), settlementId, body, mentions]);
}

export interface InboxRow { id: string; kind: "transaction" | "channel"; title: string; role: Role | "staff"; unread: number; muted: boolean; archived: boolean; lastBody: string | null; lastAt: string | null; lastSender: string | null }

const LAST = (col: string) => `(SELECT ${col} FROM transaction_messages m LEFT JOIN app_user u ON u.id = m.sender_id WHERE m.thread_id = th.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1)`;
const UNREAD = `(SELECT count(*) FROM transaction_messages m WHERE m.thread_id = th.id AND m.sender_id IS DISTINCT FROM $1::uuid AND m.created_at > COALESCE(p.last_read_at, 'epoch'))`;

/** Every conversation the person can open, most recent first, with unread counts: their deals, plus the team channels for staff. */
export async function inbox(db: Queryable, userId: string, viewer: Viewer = PERSON): Promise<{ threads: InboxRow[]; unread: number }> {
  const deals = (await db.query(
    `SELECT th.id, l.title, bu.display_name AS buyer_name, s.archived_at, COALESCE(p.muted, false) AS muted,
            CASE WHEN t.buyer_id = $1::uuid THEN 'buyer' WHEN t.seller_id = $1::uuid THEN 'seller' ELSE 'agent' END AS role,
            ${LAST("m.body")} AS last_body, ${LAST("m.created_at")} AS last_at, ${LAST("u.display_name")} AS last_sender, ${UNREAD} AS unread
       FROM settlement_timeline t JOIN message_threads th ON th.id = t.id
       JOIN property_listing l ON l.id = t.listing_id JOIN app_user bu ON bu.id = t.buyer_id
       LEFT JOIN thread_settings s ON s.thread_id = th.id LEFT JOIN message_participants p ON p.thread_id = th.id AND p.user_id = $1::uuid
      WHERE t.buyer_id <> t.seller_id AND ($1::uuid IN (t.buyer_id, t.seller_id)
        OR EXISTS (SELECT 1 FROM listing_agent_appointment a WHERE a.listing_id = t.listing_id AND a.agent_user_id = $1::uuid AND a.revoked_at IS NULL)) LIMIT 200`, [userId])).rows
    .map((r): InboxRow => ({
      id: String(r["id"]), kind: "transaction", title: threadTitle(String(r["title"]), String(r["buyer_name"])), role: String(r["role"]) as Role, unread: Number(r["unread"]), muted: Boolean(r["muted"]),
      archived: r["archived_at"] != null, lastBody: r["last_body"] ? snippet(String(r["last_body"])) : null, lastAt: r["last_at"] ? iso(r["last_at"]) : null, lastSender: r["last_sender"] ? String(r["last_sender"]) : null
    }));
  const perms = viewer.staffPermissions;
  const chans = !perms ? [] : (await db.query(
    `SELECT th.id, th.channel, COALESCE(p.muted, false) AS muted, ${LAST("m.body")} AS last_body, ${LAST("m.created_at")} AS last_at, ${LAST("u.display_name")} AS last_sender, ${UNREAD} AS unread
       FROM message_threads th LEFT JOIN message_participants p ON p.thread_id = th.id AND p.user_id = $1::uuid WHERE th.kind = 'channel'`, [userId])).rows
    .filter(r => isChannel(String(r["channel"])) && mayUseChannel(String(r["channel"]) as Channel, perms))
    .map((r): InboxRow => ({
      id: String(r["id"]), kind: "channel", title: CHANNEL_ACCESS[String(r["channel"]) as Channel].label, role: "staff", unread: Number(r["unread"]), muted: Boolean(r["muted"]), archived: false,
      lastBody: r["last_body"] ? snippet(String(r["last_body"])) : null, lastAt: r["last_at"] ? iso(r["last_at"]) : null, lastSender: r["last_sender"] ? String(r["last_sender"]) : null
    }));
  const threads = [...deals, ...chans].sort((a, b) => Number(a.archived) - Number(b.archived) || (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || a.title.localeCompare(b.title));
  return { threads, unread: threads.filter(t => !t.muted && !t.archived).reduce((n, t) => n + t.unread, 0) };
}
