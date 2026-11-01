"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Bell,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { NAV_ITEMS } from "@/components/cabinet/nav";
import { LoadingState } from "@/components/empty-state";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ROLE_LABELS } from "@/lib/roles";
import { useStore, userNotifications } from "@/lib/store";
import { cn } from "@/lib/utils";

function NavList({
  onNavigate,
  collapsed,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const { user } = useStore();
  if (!user) return null;

  const items = NAV_ITEMS.filter((item) =>
    user.sections.includes(item.section)
  );

  return (
    <nav className="flex flex-col gap-1 p-2">
      {items.map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(item.href + "/");
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            title={item.label}
            className={cn(
              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-medium tracking-tight transition-colors duration-200",
              active
                ? "bg-white/12 text-white"
                : "text-white/60 hover:bg-white/6 hover:text-white",
              collapsed && "justify-center px-2"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!collapsed ? <span className="truncate">{item.label}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    ready,
    user,
    logout,
    data,
    markNotificationRead,
    markAllNotificationsRead,
    unreadCount,
  } = useStore();
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (ready && !user) router.replace("/login");
  }, [ready, user, router]);

  if (!ready) return <LoadingState label="Загрузка кабинета…" />;
  if (!user) return <LoadingState label="Переход ко входу…" />;

  const notes = userNotifications(data.notifications, user.id).slice(0, 8);
  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2);

  return (
    <div className="flex min-h-screen bg-[var(--tk-canvas)]">
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-white/8 bg-[var(--tk-sidebar)] text-white transition-[width] duration-300 lg:flex",
          collapsed ? "w-[76px]" : "w-[248px]"
        )}
      >
        <div className="flex h-[68px] items-center justify-between gap-2 px-3">
          <Link href="/cabinet" className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--tk-accent)] font-[family-name:var(--font-display)] text-sm font-semibold text-[#1a120c]">
              ТК
            </span>
            {!collapsed ? (
              <span className="truncate font-[family-name:var(--font-display)] text-[15px] font-semibold tracking-tight text-white">
                ТендерКонтур
              </span>
            ) : null}
          </Link>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-white/50 hover:bg-white/8 hover:text-white"
            onClick={() => setCollapsed((v) => !v)}
            aria-label="Свернуть меню"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-1">
          <NavList collapsed={collapsed} />
        </div>
        {!collapsed ? (
          <div className="px-4 py-4 text-[11px] tracking-wide text-white/35">
            Договор № TMA361
          </div>
        ) : null}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-[68px] items-center justify-between gap-3 border-b border-[var(--tk-line)] bg-white/90 px-4 backdrop-blur-md sm:px-6">
          <div className="flex items-center gap-2">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger
                className="inline-flex size-8 items-center justify-center rounded-lg border border-[var(--tk-line)] bg-white lg:hidden"
                aria-label="Меню"
              >
                <Menu className="h-4 w-4" />
              </SheetTrigger>
              <SheetContent
                side="left"
                className="flex w-[280px] flex-col overflow-hidden p-0"
              >
                <div className="flex h-16 shrink-0 items-center gap-2 border-b border-[var(--tk-line)] px-4">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--tk-steel)] font-[family-name:var(--font-display)] text-sm font-bold text-white">
                    ТК
                  </span>
                  <span className="font-[family-name:var(--font-display)] text-base">
                    ТендерКонтур
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <NavList onNavigate={() => setMobileOpen(false)} />
                </div>
              </SheetContent>
            </Sheet>
            <div className="hidden rounded-full border border-[var(--tk-line)] bg-white px-3 py-1 text-[13px] text-[var(--tk-ink-soft)] sm:block">
              {data.organizations.find((o) => o.id === user.orgId)?.name}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger className="relative inline-flex size-8 items-center justify-center rounded-lg border border-[var(--tk-line)] bg-white">
                <Bell className="h-4 w-4" />
                {unreadCount > 0 ? (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-md bg-[var(--tk-copper)] px-1 text-[10px] font-semibold text-white">
                    {unreadCount}
                  </span>
                ) : null}
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-80 max-w-[calc(100vw-2rem)]"
              >
                <DropdownMenuLabel className="flex items-center justify-between gap-2">
                  <span>Уведомления</span>
                  {unreadCount > 0 ? (
                    <button
                      type="button"
                      className="text-xs font-normal text-[var(--tk-copper-deep)] hover:underline"
                      onClick={(e) => {
                        e.preventDefault();
                        void markAllNotificationsRead();
                      }}
                    >
                      Прочитать все
                    </button>
                  ) : null}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {notes.length === 0 ? (
                  <div className="px-2 py-6 text-center text-sm text-[var(--tk-muted)]">
                    Нет уведомлений
                  </div>
                ) : (
                  notes.map((n) => (
                    <DropdownMenuItem
                      key={n.id}
                      className="flex flex-col items-start gap-1 py-2"
                      onClick={() => {
                        markNotificationRead(n.id);
                        if (n.href) router.push(n.href);
                      }}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-sm font-medium">{n.title}</span>
                        {!n.read ? (
                          <Badge variant="secondary" className="text-[10px]">
                            новое
                          </Badge>
                        ) : null}
                      </div>
                      <span className="text-xs text-[var(--tk-muted)]">
                        {n.body}
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-[var(--tk-steel-50)]">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="bg-[var(--tk-steel-50)] text-[var(--tk-steel)]">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden max-w-[140px] truncate text-left text-sm md:block">
                  {user.name}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>
                  <div className="font-medium">{user.name}</div>
                  <div className="text-xs font-normal text-[var(--tk-muted)]">
                    {ROLE_LABELS[user.role]}
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={async () => {
                    await logout();
                    router.push("/login");
                  }}
                >
                  <LogOut className="h-4 w-4" />
                  Выйти
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="relative flex-1 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-7 sm:py-8 lg:px-10">
          <div key={pathname} className="tk-page relative mx-auto w-full max-w-[1180px]">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
