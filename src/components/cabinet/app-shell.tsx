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
import { Logo } from "@/components/logo";
import { LoadingState } from "@/components/empty-state";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
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
  prominent = false,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
  prominent?: boolean;
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
                ? "bg-white/16 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.32)]"
                : prominent
                  ? "text-white hover:bg-white/10"
                  : "text-white/80 hover:bg-white/8 hover:text-white",
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
    <div className="flex h-dvh max-h-dvh overflow-hidden bg-transparent">
      {/*
        Product layout: sidebar + header are in a fixed viewport shell;
        only <main> scrolls. Avoid position:sticky here — sticky chrome
        duplicates mid-page in long captures and can cover content.
      */}
      <aside
        className={cn(
          "tk-glass-dark relative hidden h-full shrink-0 flex-col overflow-y-auto border-r text-white transition-[width] duration-300 lg:flex",
          collapsed ? "w-[76px]" : "w-[248px]"
        )}
      >
        <div
          className={cn(
            "flex h-[68px] items-center px-3",
            collapsed ? "justify-center" : "justify-between gap-2"
          )}
        >
          <Link href="/cabinet" className="flex min-w-0 items-center" aria-label="истройка">
            <Logo wordmark={!collapsed} />
          </Link>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              "text-white/50 hover:bg-white/8 hover:text-white",
              collapsed &&
                "tk-glass-dark absolute top-5 right-2 z-20 size-6 border shadow-sm"
            )}
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-3.5 w-3.5" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-1">
          <NavList collapsed={collapsed} />
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="tk-glass-bar z-30 flex h-[68px] shrink-0 items-center justify-between gap-3 border-b px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger
                className="tk-glass-chip inline-flex size-8 items-center justify-center rounded-full lg:hidden"
                aria-label="Меню"
              >
                <Menu className="h-4 w-4" />
              </SheetTrigger>
              <SheetContent
                side="left"
                className="tk-glass-dark flex w-[min(88vw,280px)] flex-col overflow-hidden p-0 text-white [&_[data-slot=sheet-close]]:text-white [&_[data-slot=sheet-close]]:hover:bg-white/10"
              >
                <div className="flex h-16 shrink-0 items-center border-b border-white/10 px-4 pr-12">
                  <Logo titleClassName="text-base" />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <NavList prominent onNavigate={() => setMobileOpen(false)} />
                </div>
              </SheetContent>
            </Sheet>
            <div className="tk-glass-chip hidden rounded-full px-3 py-1 text-[13px] text-[var(--tk-ink-soft)] sm:block">
              {data.organizations.find((o) => o.id === user.orgId)?.name}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="Уведомления" className="tk-glass-chip relative inline-flex size-8 items-center justify-center rounded-full">
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
                <DropdownMenuGroup>
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
                </DropdownMenuGroup>
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
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    <div className="font-medium">{user.name}</div>
                    <div className="text-xs font-normal text-[var(--tk-muted)]">
                      {ROLE_LABELS[user.role]}
                    </div>
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
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

        <main
          className="relative min-h-0 min-w-0 flex-1 overflow-x-clip overflow-y-auto px-4 py-6 pb-[max(6.75rem,calc(5.75rem+env(safe-area-inset-bottom)))] sm:px-7 sm:py-8 lg:px-10 lg:pb-8"
          data-testid="cabinet-main-scroll"
        >
          <div key={pathname} className="tk-page relative mx-auto w-full max-w-[1180px]">
            {children}
          </div>
        </main>
        <MobileTabBar onMore={() => setMobileOpen(true)} />
      </div>
    </div>
  );
}

function MobileTabBar({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();
  const { user } = useStore();
  if (!user) return null;
  const items = NAV_ITEMS.filter((item) => user.sections.includes(item.section));
  const primary = items.slice(0, 4);

  return (
    <nav className="tk-glass-bar fixed inset-x-0 bottom-0 z-40 border-t lg:hidden">
      <div className="flex items-stretch justify-around px-1 pt-1 pb-[max(0.35rem,env(safe-area-inset-bottom))]">
        {primary.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-2xl px-1 py-1.5 text-[10px] font-medium leading-tight",
                active
                  ? "bg-white/80 text-[var(--tk-ink)]"
                  : "text-[var(--tk-muted)]"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="max-w-full text-center leading-none">{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={onMore}
          className="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-2xl px-1 py-1.5 text-[10px] font-medium text-[var(--tk-muted)]"
        >
          <Menu className="h-4 w-4" />
          <span>Ещё</span>
        </button>
      </div>
    </nav>
  );
}
