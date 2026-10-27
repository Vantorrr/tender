"use client";

import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ALL_SECTIONS,
  DEFAULT_SECTIONS,
  ROLE_LABELS,
  SECTION_LABELS,
} from "@/lib/roles";
import type { Role, SectionKey } from "@/lib/types";
import { useStore } from "@/lib/store";
import { formatDateTime } from "@/lib/format";

export default function PolzovateliPage() {
  const {
    data,
    user,
    createUser,
    updateUser,
    setUserRole,
    setUserSections,
  } = useStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "Demo123!",
    role: "tender" as Role,
  });

  if (!user) return null;

  const canManage =
    user.role === "superadmin" || user.role === "admin";
  const orgUsers = data.users.filter((u) =>
    user.role === "superadmin" ? true : u.orgId === user.orgId
  );
  const selected = orgUsers.find((u) => u.id === selectedId) ?? null;

  if (!canManage) {
    return (
      <div>
        <PageHeader
          title="Пользователи и настройки"
          description="Недостаточно прав. Управление доступно суперадмину и администратору."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Пользователи и настройки"
        description="Создание, редактирование, блокировка, права на разделы и история ролей."
        actions={
          user.role === "superadmin" || user.role === "admin" ? (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger render={<Button />}>
                Создать пользователя
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Новый пользователь</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label>ФИО</Label>
                    <Input
                      value={form.name}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, name: e.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Email</Label>
                    <Input
                      value={form.email}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, email: e.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Пароль</Label>
                    <Input
                      value={form.password}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, password: e.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Роль</Label>
                    <Select
                      value={form.role}
                      onValueChange={(v) =>
                        setForm((f) => ({ ...f, role: (v as Role) ?? "tender" }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                          <SelectItem key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    className="w-full"
                    onClick={() => {
                      if (!form.name || !form.email) {
                        toast.error("Заполните ФИО и email");
                        return;
                      }
                      createUser({
                        name: form.name,
                        email: form.email,
                        password: form.password,
                        role: form.role,
                        orgId: user.orgId,
                        blocked: false,
                        sections: DEFAULT_SECTIONS[form.role],
                      });
                      toast.success("Пользователь создан");
                      setOpen(false);
                      setForm({
                        name: "",
                        email: "",
                        password: "Demo123!",
                        role: "tender",
                      });
                    }}
                  >
                    Сохранить
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          ) : null
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Пользователь</TableHead>
                <TableHead>Роль</TableHead>
                <TableHead>Орг.</TableHead>
                <TableHead>Статус</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orgUsers.map((u) => (
                <TableRow
                  key={u.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedId(u.id)}
                  data-state={selectedId === u.id ? "selected" : undefined}
                >
                  <TableCell>
                    <div className="font-medium">{u.name}</div>
                    <div className="text-xs text-[var(--tk-muted)]">
                      {u.email}
                    </div>
                  </TableCell>
                  <TableCell>{ROLE_LABELS[u.role]}</TableCell>
                  <TableCell>
                    {data.organizations.find((o) => o.id === u.orgId)?.name}
                  </TableCell>
                  <TableCell>
                    {u.blocked ? (
                      <Badge variant="destructive">Заблокирован</Badge>
                    ) : (
                      <Badge variant="secondary">Активен</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4">
          {selected ? (
            <div className="space-y-4">
              <div>
                <h2 className="font-[family-name:var(--font-display)] text-base">
                  {selected.name}
                </h2>
                <p className="text-sm text-[var(--tk-muted)]">
                  {selected.email}
                </p>
              </div>

              {user.role === "superadmin" ? (
                <>
                  <div className="space-y-1">
                    <Label>Роль</Label>
                    <Select
                      value={selected.role}
                      onValueChange={(v) => {
                        if (!v) return;
                        setUserRole(selected.id, v as Role, "Изменение роли");
                        toast.success("Роль обновлена");
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                          <SelectItem key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label className="mb-2 block">Права на разделы</Label>
                    <div className="grid gap-2">
                      {ALL_SECTIONS.map((section) => (
                        <label
                          key={section}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Checkbox
                            checked={selected.sections.includes(section)}
                            onCheckedChange={(checked) => {
                              const next = checked
                                ? [...selected.sections, section]
                                : selected.sections.filter((s) => s !== section);
                              setUserSections(
                                selected.id,
                                next as SectionKey[]
                              );
                            }}
                          />
                          {SECTION_LABELS[section]}
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}

              <Button
                variant={selected.blocked ? "default" : "destructive"}
                onClick={() => {
                  updateUser(selected.id, { blocked: !selected.blocked });
                  toast.success(
                    selected.blocked
                      ? "Пользователь разблокирован"
                      : "Пользователь заблокирован"
                  );
                }}
              >
                {selected.blocked ? "Разблокировать" : "Заблокировать"}
              </Button>

              <div>
                <h3 className="mb-2 text-sm font-medium">История ролей</h3>
                <ul className="space-y-2 text-sm">
                  {data.roleHistory
                    .filter((h) => h.userId === selected.id)
                    .map((h) => (
                      <li
                        key={h.id}
                        className="rounded-lg border border-[var(--tk-line)] px-3 py-2"
                      >
                        <div>
                          {h.fromRole
                            ? `${ROLE_LABELS[h.fromRole]} → ${ROLE_LABELS[h.toRole]}`
                            : `Назначена роль ${ROLE_LABELS[h.toRole]}`}
                        </div>
                        <div className="text-xs text-[var(--tk-muted)]">
                          {formatDateTime(h.at)} · {h.comment}
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[var(--tk-muted)]">
              Выберите пользователя в таблице.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
