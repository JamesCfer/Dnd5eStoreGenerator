/**
 * Patreon tier allowances and per-action use costs.
 *
 * The numbers here mirror TIER_LIMITS in the n8n usage-check workflow — the
 * relay remains the authority that enforces them, this file exists so the
 * builder can *explain* them without a round-trip. Keep the two in sync.
 *
 * Deliberately no prices: those live on the Patreon page and would go stale
 * here the first time they change.
 */

/**
 * @typedef {object} TierPlan
 * @property {string}  id          Tier id as the relay reports it (lowercase).
 * @property {string}  label       Display name.
 * @property {number}  uses        Monthly generation uses.
 * @property {boolean} isFree      True for the no-pledge allowance.
 * @property {boolean} [internal]  Hidden from the comparison table.
 */

/** @type {TierPlan[]} */
export const TIER_PLANS = [
  { id: 'free',         label: 'Free',         uses: 3,      isFree: true },
  { id: 'supporter',    label: 'Supporter',    uses: 25,     isFree: false },
  { id: 'professional', label: 'Professional', uses: 100,    isFree: false },
  { id: 'premium',      label: 'Premium',      uses: 200,    isFree: false },
  { id: 'superuser',    label: 'Superuser',    uses: 999999, isFree: false, internal: true },
];

/** Tier ids the relay treats as "no pledge". */
const FREE_ALIASES = ['', 'free', 'none', 'no tier'];

/**
 * What each action costs against the monthly allowance, matching the amount
 * the relay workflows actually add to npc_count. Stores cost more because one
 * generation produces a shopkeeper plus a stocked inventory.
 */
export const ACTION_COSTS = [
  { id: 'generation', label: 'NPC, creature, or item', cost: 1 },
  { id: 'store',      label: 'Store (shopkeeper + stock)', cost: 7 },
  { id: 'image',      label: 'AI portrait', cost: 4 },
];

/**
 * Resolve a relay-reported tier string to its plan.
 *
 * @param {string|null|undefined} tier
 * @returns {TierPlan} The matching plan, falling back to Free.
 */
export function getPlan(tier) {
  const id = String(tier ?? '').trim().toLowerCase();
  if (FREE_ALIASES.includes(id)) return TIER_PLANS[0];
  return TIER_PLANS.find(p => p.id === id) || TIER_PLANS[0];
}

/**
 * Plans shown in the home-tab comparison table — public tiers only.
 * @returns {TierPlan[]}
 */
export function publicPlans() {
  return TIER_PLANS.filter(p => !p.internal);
}

/**
 * The cheapest public plan that beats the given tier, i.e. the one worth
 * pitching. Returns null when the user is already on the top tier.
 *
 * @param {string|null|undefined} tier
 * @returns {TierPlan|null}
 */
export function nextPlanUp(tier) {
  const current = getPlan(tier);
  return publicPlans().find(p => p.uses > current.uses) || null;
}

/**
 * Roughly how many of each thing an allowance buys, for the "25 uses gets you…"
 * line on the home tab.
 *
 * @param {number} uses
 * @returns {string}
 */
export function describeAllowance(uses) {
  const parts = ACTION_COSTS
    .filter(a => a.id !== 'image')
    .map(a => ({ n: Math.floor(uses / a.cost), noun: a.id === 'store' ? 'stores' : 'NPCs or items' }))
    .filter(p => p.n > 0)
    .map(p => `${p.n} ${p.noun}`);
  return parts.join(', or ');
}
