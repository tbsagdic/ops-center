"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Plus,
  MoreHorizontal,
  RefreshCw,
  Eye,
  RotateCcw,
  KeyRound,
  Globe,
  Pencil,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/status-badge";
import { FormDrawer } from "@/components/form-drawer";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { LicenseForm } from "./license-form";
import { LicenseEditForm, type EditableLicense } from "./license-edit-form";
import { LicenseKeyDialog } from "./license-key-dialog";
import { DomainManager, type DomainItem } from "./domain-manager";
import type { LicenseProjectOption } from "@/lib/licenses/domain-candidates";
import {
  renewLicense,
  revealLicenseKey,
  resetActivations,
  rotateLicenseKey,
  deleteLicense,
} from "@/actions/licenses";
import { formatDate } from "@/lib/format";
import { useRouter } from "next/navigation";

export type LicenseRow = EditableLicense & {
  key_prefix: string;
  expires_at: string | null;
  domains: DomainItem[];
};

export function LicensesView({
  licenses,
  projects,
  canCreate,
  canUpdate,
  canDelete,
}: {
  licenses: LicenseRow[];
  projects: LicenseProjectOption[];
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [keyToShow, setKeyToShow] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<LicenseRow | null>(null);
  const [domainTarget, setDomainTarget] = useState<LicenseRow | null>(null);
  const [, startTransition] = useTransition();

  function reveal(id: string) {
    startTransition(async () => {
      const res = await revealLicenseKey(id);
      if (res.success) setKeyToShow(res.data.licenseKey);
      else toast.error(res.error);
    });
  }

  return (
    <>
      {canCreate && (
        <div className="flex justify-end">
          <Button onClick={() => setCreateOpen(true)} className="bg-[#5267ff] hover:bg-[#4254e1]">
            <Plus className="mr-1 h-4 w-4" />
            Yeni Lisans Üret
          </Button>
        </div>
      )}

      {licenses.length === 0 ? (
        <EmptyState icon="KeyRound" title="Lisans bulunamadı" description="Bir proje için yeni lisans üretin." />
      ) : (
        <div className="overflow-x-auto rounded-[22px] border border-slate-200/80 bg-white shadow-sm">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Anahtar</TableHead>
                <TableHead>Ürün / Proje</TableHead>
                <TableHead>Müşteri</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead>Aktivasyon</TableHead>
                <TableHead>Bitiş</TableHead>
                <TableHead>Durum</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {licenses.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-mono text-xs font-semibold">{l.key_prefix}-••••</TableCell>
                  <TableCell>
                    <div className="font-semibold text-[#141821]">{l.product_name}</div>
                    <div className="text-xs text-muted-foreground">{l.project_code}</div>
                  </TableCell>
                  <TableCell className="text-sm">{l.customer_name}</TableCell>
                  <TableCell>
                    {l.domains.length > 0 ? (
                      <>
                        <div className="text-sm font-medium text-[#141821]">
                          {(l.domains.find((domain) => domain.is_primary) ?? l.domains[0])
                            .normalized_domain}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {(l.domains.find((domain) => domain.is_primary) ?? l.domains[0])
                            .environment}
                          {l.domains.length > 1 ? ` +${l.domains.length - 1}` : ""}
                        </div>
                      </>
                    ) : (
                      <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
                        Domain eksik
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {l.active_activations} / {l.activation_limit}
                  </TableCell>
                  <TableCell className="text-sm">
                    {l.expires_at ? (
                      formatDate(l.expires_at)
                    ) : (
                      <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                        Süresiz
                      </span>
                    )}
                  </TableCell>
                  <TableCell><StatusBadge status={l.status} /></TableCell>
                  <TableCell>
                    {(canUpdate || canCreate || canDelete) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          {canUpdate && (
                            <DropdownMenuItem onClick={() => setEditTarget(l)}>
                              <Pencil className="mr-2 h-4 w-4" />
                              Düzenle
                            </DropdownMenuItem>
                          )}
                          {canUpdate && l.expires_at !== null && <ConfirmDialog
                            trigger={
                              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                                <RefreshCw className="mr-2 h-4 w-4" />
                                1 Yıl Yenile
                              </DropdownMenuItem>
                            }
                            title="Lisansı Yenile"
                            description="Lisans süresine 1 yıl eklenecek. Onaylıyor musunuz?"
                            confirmLabel="Yenile"
                            action={() => renewLicense(l.id)}
                          />}
                          {canUpdate && <DropdownMenuItem onClick={() => reveal(l.id)}>
                            <Eye className="mr-2 h-4 w-4" />
                            Anahtarı Göster
                          </DropdownMenuItem>}
                          {(canCreate || canUpdate || canDelete) && <DropdownMenuItem onClick={() => setDomainTarget(l)}>
                            <Globe className="mr-2 h-4 w-4" />
                            Domainler ({l.domains.length})
                          </DropdownMenuItem>}
                          {canUpdate && <DropdownMenuSeparator />}
                          {canUpdate && <ConfirmDialog
                            trigger={
                              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                                <RotateCcw className="mr-2 h-4 w-4" />
                                Aktivasyonları Sıfırla
                              </DropdownMenuItem>
                            }
                            title="Aktivasyonları Sıfırla"
                            description="Tüm aktif kurulumlar devre dışı bırakılacak. Onaylıyor musunuz?"
                            confirmLabel="Sıfırla"
                            destructive
                            action={() => resetActivations(l.id)}
                          />}
                          {canUpdate && (
                            <ConfirmDialog
                              trigger={
                                <DropdownMenuItem
                                  onSelect={(e) => e.preventDefault()}
                                  className="text-rose-600 focus:text-rose-600"
                                >
                                  <KeyRound className="mr-2 h-4 w-4" />
                                  Anahtar Rotasyonu
                                </DropdownMenuItem>
                              }
                              title="Anahtar Rotasyonu"
                              description="Yeni bir anahtar üretilecek; eski anahtar geçersizleşecek ve tüm aktivasyonlar deaktive olacak. Bu işlem geri alınamaz."
                              confirmLabel="Döndür"
                              destructive
                              action={async () => {
                                const res = await rotateLicenseKey(l.id);
                                if (res.success) {
                                  setKeyToShow(res.data.licenseKey);
                                  router.refresh();
                                }
                                return res;
                              }}
                            />
                          )}
                          {canDelete && <DropdownMenuSeparator />}
                          {canDelete && (
                            <ConfirmDialog
                              trigger={
                                <DropdownMenuItem
                                  onSelect={(event) => event.preventDefault()}
                                  className="text-rose-600 focus:text-rose-600"
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Sil
                                </DropdownMenuItem>
                              }
                              title="Lisansı Sil"
                              description={`"${l.product_name}" lisansı kalıcı olarak silinecek. Bağlı domain, aktivasyon ve olay kayıtları da kaldırılacak.`}
                              confirmLabel="Sil"
                              destructive
                              action={() => deleteLicense(l.id)}
                            />
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <FormDrawer
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Yeni Lisans Üret"
        description="Proje, domain ve süre bilgilerini girin."
      >
        <LicenseForm
          projects={projects}
          onCreated={(key) => {
            setCreateOpen(false);
            setKeyToShow(key);
          }}
          onCancel={() => setCreateOpen(false)}
        />
      </FormDrawer>

      {editTarget && (
        <FormDrawer
          open={Boolean(editTarget)}
          onOpenChange={(open) => !open && setEditTarget(null)}
          title="Lisans Düzenle"
          description="Müşteri, süre, limit ve durum bilgilerini güncelleyin."
        >
          <LicenseEditForm
            license={editTarget}
            onDone={() => setEditTarget(null)}
          />
        </FormDrawer>
      )}

      <LicenseKeyDialog licenseKey={keyToShow} onClose={() => setKeyToShow(null)} />

      {domainTarget && (
        <DomainManager
          open={Boolean(domainTarget)}
          onOpenChange={(o) => !o && setDomainTarget(null)}
          licenseId={domainTarget.id}
          domains={domainTarget.domains}
          canCreate={canCreate}
          canUpdate={canUpdate}
          canDelete={canDelete}
        />
      )}
    </>
  );
}
