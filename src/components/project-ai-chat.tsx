"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { LoaderCircle, MessageCircle, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { api } from "@/lib/api";
import type { ProjectChatMessage, ProjectChatScreen } from "@/lib/types";
import { cn } from "@/lib/utils";

const SCREEN_LABEL: Record<ProjectChatScreen, string> = {
  procurement: "Закупка",
  calculation: "Расчёт",
  gpr: "ГПР",
  production: "Производство",
};

const SUGGESTIONS = [
  "Какие важные риски есть в проекте?",
  "Каких данных не хватает для расчёта?",
  "Что сейчас известно о сроках и оплате?",
];

type ChatLoadResponse = { modelAvailable: boolean; messages: ProjectChatMessage[] };

export function ProjectAiChat({
  procurementId,
  projectTitle,
  screen,
}: {
  procurementId: string;
  projectTitle: string;
  screen: ProjectChatScreen;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ProjectChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [modelAvailable, setModelAvailable] = useState<boolean | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const historyRequestRef = useRef(0);

  async function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      historyRequestRef.current += 1;
      return;
    }
    const requestId = ++historyRequestRef.current;
    setLoadingHistory(true);
    setError(null);
    try {
      const response = await api<ChatLoadResponse>(`/api/ai/project-chat?procurementId=${encodeURIComponent(procurementId)}&screen=${screen}`);
      if (requestId !== historyRequestRef.current) return;
      setMessages(response.messages);
      setModelAvailable(response.modelAvailable);
    } catch (reason) {
      if (requestId === historyRequestRef.current) setError(reason instanceof Error ? reason.message : "Не удалось открыть чат");
    } finally {
      if (requestId === historyRequestRef.current) setLoadingHistory(false);
    }
  }

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, open, sending]);

  async function sendMessage(raw: string) {
    const message = raw.trim();
    if (!message || sending || loadingHistory) return;
    setDraft("");
    setSending(true);
    setError(null);
    try {
      const result = await api<{ userMessage: ProjectChatMessage; assistantMessage: ProjectChatMessage }>(
        "/api/ai/project-chat",
        {
          method: "POST",
          body: JSON.stringify({ procurementId, screen, message }),
        }
      );
      setMessages((current) => [...current, result.userMessage, result.assistantMessage]);
    } catch (reason) {
      setDraft(message);
      setError(reason instanceof Error ? reason.message : "Не удалось получить ответ");
    } finally {
      setSending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(draft);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(draft);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => void handleOpenChange(nextOpen)}>
      <Button variant="outline" onClick={() => void handleOpenChange(true)} aria-label={`Спросить ИИ · ${projectTitle}`}>
        <MessageCircle aria-hidden="true" />
        Спросить ИИ
      </Button>
      <SheetContent side="right" className="w-[min(100vw,30rem)] gap-0 p-0 sm:max-w-[30rem]">
        <SheetHeader className="border-b border-[var(--tk-line)] pr-12">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-[var(--tk-copper-deep)]" aria-hidden="true" />
            Чат по закупке
          </SheetTitle>
          <SheetDescription className="line-clamp-2">
            {projectTitle} · контекст: {SCREEN_LABEL[screen]}
          </SheetDescription>
        </SheetHeader>

        <div className="border-b border-[var(--tk-line)] bg-stone-50 px-4 py-2.5 text-xs leading-relaxed text-[var(--tk-muted)]">
          ИИ использует карточку, документы, расчёт, ГПР, риски и план/факт этого проекта. Вопрос и выдержки отправляются настроенной модели OpenRouter; ответы требуют проверки по источникам.
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
          {loadingHistory ? (
            <div className="flex items-center gap-2 py-8 text-sm text-[var(--tk-muted)]">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Загружаю историю…
            </div>
          ) : messages.length === 0 ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-[var(--tk-line)] bg-white p-3 text-sm leading-relaxed">
                Задайте вопрос по этой закупке. Если в документах или расчёте нет подтверждения, я прямо скажу об этом и не буду додумывать.
              </div>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    disabled={sending || loadingHistory || modelAvailable === false}
                    onClick={() => void sendMessage(suggestion)}
                    className="rounded-full border border-[var(--tk-line)] bg-white px-3 py-1.5 text-left text-xs hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((item) => (
                <div key={item.id} className={cn("flex", item.role === "user" ? "justify-end" : "justify-start")}>
                  <div className={cn("max-w-[92%] rounded-xl px-3 py-2.5 text-sm", item.role === "user" ? "bg-primary text-primary-foreground" : "border border-[var(--tk-line)] bg-white")}>
                    <p className="whitespace-pre-wrap break-words leading-relaxed">{item.content}</p>
                    {item.role === "assistant" && item.sources?.length ? (
                      <div className="mt-3 space-y-2 border-t border-[var(--tk-line)] pt-2">
                        <p className="text-[11px] font-medium text-[var(--tk-muted)]">Источники</p>
                        {item.sources.map((source) => (
                          <div key={source.id} className="rounded-md bg-stone-50 p-2 text-xs text-foreground">
                            {source.href ? (
                              <Link className="font-medium underline underline-offset-2" href={source.href} onClick={() => setOpen(false)}>{source.label}</Link>
                            ) : <span className="font-medium">{source.label}</span>}
                            <p className="mt-1 text-[var(--tk-muted)]">«{source.quote}»</p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <p className={cn("mt-1 text-[10px]", item.role === "user" ? "text-primary-foreground/70" : "text-[var(--tk-muted)]")}>
                      {SCREEN_LABEL[item.screen]} · {new Date(item.createdAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
          {sending ? (
            <div className="mt-4 flex items-center gap-2 text-xs text-[var(--tk-muted)]" role="status">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Проверяю документы и расчёт…
            </div>
          ) : null}
          {error ? <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
          {modelAvailable === false ? <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">Чат пока не настроен. Администратору нужно подключить ИИ‑модель.</p> : null}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={submit} className="border-t border-[var(--tk-line)] bg-background p-3">
          <label className="sr-only" htmlFor={`project-chat-input-${procurementId}`}>Вопрос по закупке</label>
          <div className="flex items-end gap-2">
            <Textarea
              id={`project-chat-input-${procurementId}`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
              maxLength={1200}
              rows={2}
              placeholder="Спросите о документах, смете, сроках, рисках…"
              disabled={sending || loadingHistory || modelAvailable === false}
              className="max-h-36 min-h-10 resize-y bg-white text-sm"
            />
            <Button type="submit" size="icon" aria-label="Отправить вопрос" disabled={!draft.trim() || sending || loadingHistory || modelAvailable === false}>
              {sending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-[var(--tk-muted)]">Enter — отправить · Shift+Enter — новая строка · до 1 200 символов</p>
        </form>
      </SheetContent>
    </Sheet>
  );
}
