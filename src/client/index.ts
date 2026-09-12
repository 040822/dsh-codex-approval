import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// `slots` is provided by the client UI renderer (its client half owns the
// SlotRegistry service); there is no separate `dsh-client-ui-slots` client
// module in the graph, so the renderer is the module to depend on.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DshCodexApprovalCard } from './DshCodexApprovalCard.tsx'
import { resolveModelCatalogLoader } from '../../client-remote.js'
import { ensureCardStyle } from '../../client-card-style.js'

/**
 * Services this browser half needs. `remote.session` is a **dotted service
 * name**: the cordis context proxy throws `cannot get property
 * "remote.session" without inject` unless that exact name is declared, so
 * `remote` alone is not enough (the shipped settings-plugins tab declares both).
 */
export const inject = ['locale', 'settingsScope', 'slots', 'remote', 'remote.session']

export function apply(ctx: any): void {
  // One stylesheet for the card, injected with the shipped plugins' own
  // `data-plugin-css` convention.
  ensureCardStyle()
  ctx.inject(['slots', 'settingsScope', 'locale', 'remote', 'remote.session'], (scope: any) => {
    const settingsScope = scope.settingsScope.bind({ namespace: 'dsh-codex-approval-config' })
    // Resolve the catalog call here, on the only fiber allowed to touch the
    // guarded `remote.session` service, and hand the card a plain function:
    // slot entries render in the tab's fiber, where that proxy would throw and
    // crash the whole card with "slot entry crashed in 'settings.plugin.item'".
    const loadModelCatalog = resolveModelCatalogLoader(scope)
    scope.slots.inject('settings.plugin.item', () => scope.slots.register({
      name: 'settings.plugin.item',
      key: 'dsh-codex-approval-config',
      locale: 'dsh-codex-approval',
      inject: () => ({ settingsScope, loadModelCatalog }),
    }, DshCodexApprovalCard))
  })
}
