import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { OrderSchema, type Order } from "./models.js";

export class OrderStore {
  private readonly orders: Map<string, Order>;

  constructor(path: string) {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const list = z.array(OrderSchema).parse(raw);
    this.orders = new Map(list.map((o) => [o.order_id, o]));
  }

  get(orderId: string): Order | undefined {
    return this.orders.get(orderId.toUpperCase());
  }
}

export interface Refund {
  refundId: string;
  orderId: string;
  amount: number;
  currency: string;
  ticketId: string;
  status: "issued";
  createdAt: string;
}

export interface Escalation {
  escalationId: string;
  ticketId: string;
  orderId: string | null;
  reason: string;
  priority: "low" | "normal" | "high";
  queue: string;
  createdAt: string;
}

export class CaseStore {
  readonly refunds = new Map<string, Refund>();
  readonly escalations: Escalation[] = [];

  hasRefund(orderId: string): boolean {
    return this.refunds.has(orderId);
  }

  createRefund(
    orderId: string,
    amount: number,
    currency: string,
    ticketId: string,
  ): Refund {
    if (this.refunds.has(orderId)) {
      throw new Error(`Refund already exists for ${orderId}`);
    }
    const refund: Refund = {
      refundId: `RF-${randomUUID().slice(0, 8).toUpperCase()}`,
      orderId,
      amount: round2(amount),
      currency,
      ticketId,
      status: "issued",
      createdAt: new Date().toISOString(),
    };
    this.refunds.set(orderId, refund);
    return refund;
  }

  createEscalation(
    ticketId: string,
    orderId: string | null,
    reason: string,
    priority: Escalation["priority"],
  ): Escalation {
    const esc: Escalation = {
      escalationId: `ESC-${randomUUID().slice(0, 8).toUpperCase()}`,
      ticketId,
      orderId,
      reason,
      priority,
      queue: "refunds-tier2",
      createdAt: new Date().toISOString(),
    };
    this.escalations.push(esc);
    return esc;
  }

  snapshot() {
    return {
      refunds: [...this.refunds.values()],
      escalations: [...this.escalations],
    };
  }
}

export interface PolicyHit {
  ref: string;
  title: string;
  text: string;
  score: number;
}

interface Chunk {
  ref: string;
  title: string;
  text: string;
  tf: Map<string, number>;
}

const STOP_WORDS = new Set(
  "a an the and or of to for in on is are be it my i me we you your our this that with at by as do does did can could would should will from if not no".split(
    " ",
  ),
);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOP_WORDS.has(t),
  );
}

export class PolicyIndex {
  private readonly chunks: Chunk[] = [];
  private readonly idf = new Map<string, number>();

  constructor(policyDir: string) {
    const files = readdirSync(policyDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const file of files) {
      const doc = basename(file, ".md");
      for (const { title, text } of splitSections(
        readFileSync(join(policyDir, file), "utf-8"),
      )) {
        const slug = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        const tf = new Map<string, number>();
        for (const t of tokenize(`${title} ${text}`))
          tf.set(t, (tf.get(t) ?? 0) + 1);
        this.chunks.push({
          ref: `${doc}#${slug}`,
          title,
          text: text.trim(),
          tf,
        });
      }
    }

    const df = new Map<string, number>();
    for (const c of this.chunks)
      for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const n = this.chunks.length;
    for (const [t, d] of df) this.idf.set(t, Math.log((n + 1) / (d + 0.5)));
  }

  search(query: string, topK = 3): PolicyHit[] {
    const q = tokenize(query);
    return this.chunks
      .map((c) => {
        let score = 0;
        for (const t of q) {
          const f = c.tf.get(t);
          if (f) score += (1 + Math.log(f)) * (this.idf.get(t) ?? 0);
        }
        return {
          ref: c.ref,
          title: c.title,
          text: c.text,
          score: round2(score),
        };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref))
      .slice(0, topK);
  }

  refs(): Set<string> {
    return new Set(this.chunks.map((c) => c.ref));
  }
}

function splitSections(md: string): { title: string; text: string }[] {
  const sections: { title: string; text: string }[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of md.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      if (current)
        sections.push({ title: current.title, text: current.lines.join("\n") });
      current = { title: line.slice(3).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current)
    sections.push({ title: current.title, text: current.lines.join("\n") });
  return sections;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
