// Test-only React harness: real component, real providers and formal local APIs.
// Never imported by the product bundle.
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "../client/src/lib/trpc";
import { I18nProvider } from "../client/src/lib/i18n";
import { SourceImportDialog } from "../client/src/components/product/SourceImportDialog";

export function mountReviewLifecycle() {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({ links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })] });
  let mounted = true, created = 0;
  const render = (open: boolean) => root.render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}><I18nProvider>
        <SourceImportDialog open={open} onClose={() => render(false)} onCreated={() => { created++; }} />
      </I18nProvider></QueryClientProvider>
    </trpc.Provider>
  );
  render(true);
  return {
    close: () => render(false),
    unmount: () => { if (mounted) { mounted = false; root.unmount(); host.remove(); } },
    created: () => created,
    cachedPreviews: () => queryClient.getQueryCache().getAll().filter(q => JSON.stringify(q.queryKey).includes('"getUrl"')).length,
    dispose() { if (mounted) { mounted = false; root.unmount(); host.remove(); } queryClient.clear(); },
  };
}
