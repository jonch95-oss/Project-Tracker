import { AppShell } from "@/components/shell/app-shell";
import { ToastProvider } from "@/components/ui/overlay";
import { TRPCReactProvider } from "@/lib/trpc";
import { requireViewer } from "@/server/session";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const viewer = await requireViewer();
  return (
    <TRPCReactProvider>
      <ToastProvider>
        <AppShell viewer={{ name: viewer.name, email: viewer.email, role: viewer.role, title: viewer.title }}>{children}</AppShell>
      </ToastProvider>
    </TRPCReactProvider>
  );
}
