import { useEffect, useState } from "react";
import { ChevronDown, Layers, RefreshCw } from "lucide-react";
import { getServiceProfiles, ServiceProfileSummary } from "../api";
import { Alert, Badge, Button, Card, EmptyState, SectionHeader, Spinner } from "../components/ui";

function BulletList({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-mute">{title}</h4>
      <ul className="mt-1.5 space-y-1">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 text-[13px] text-ink-soft">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-mute" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function priceLabel(value: number | null, currency: string): string {
  return typeof value === "number" ? `${value} ${currency}` : "—";
}

export function ServiceProfiles() {
  const [profiles, setProfiles] = useState<ServiceProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getServiceProfiles();
      setProfiles(data.profiles ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load service profiles.");
      setProfiles([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Service Profiles"
        description="Each profile describes one offer — its audience, pains, benefits, objections, and qualification rules. The sales methodology is shared; services are data."
        actions={
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        }
      />

      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-ink-soft">
          <Spinner className="h-4 w-4" /> Loading service profiles…
        </div>
      ) : error ? (
        <Alert tone="danger" title="Could not load service profiles">
          {error}
        </Alert>
      ) : profiles.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Layers className="h-5 w-5" />}
            title="No service profiles registered"
            description="The backend returned no service profiles."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {profiles.map((profile) => (
            <details key={profile.id} className="group rounded-xl border border-line bg-surface/80">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[14px] font-semibold text-ink">{profile.name}</h3>
                    <Badge tone="neutral">{profile.toolsCount} tools</Badge>
                  </div>
                  <p className="mt-1 text-[13px] text-ink-soft">{profile.description}</p>
                </div>
                <ChevronDown className="h-4 w-4 shrink-0 text-ink-mute transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-5 border-t border-line px-5 py-5">
                {profile.persona && (
                  <p className="text-[13px] italic text-ink-soft">{profile.persona}</p>
                )}
                {!profile.profileAvailable && (
                  <Alert tone="warn" title="No data-only playbook for this service">
                    This adapter is registered with the engine but does not expose a structured ServiceProfile, so its
                    audience, pains, and objection playbook are not available here yet.
                  </Alert>
                )}
                <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                  <BulletList title="Ideal customers" items={profile.idealCustomers} />
                  <BulletList title="Pain points" items={profile.painPoints} />
                  <BulletList title="Benefits / value" items={profile.benefits} />
                  <BulletList title="Qualification rules" items={profile.qualificationRules} />
                  <BulletList title="Discovery questions" items={profile.discoveryQuestions} />
                  <BulletList title="Buying signals" items={profile.buyingSignals} />
                  <BulletList title="Calls to action" items={profile.ctas} />
                  <BulletList
                    title="Enforced behavioral policies"
                    items={profile.policies.map((p) => `${p.name}${p.strict ? " (strict)" : ""}`)}
                  />
                </div>

                {profile.objections.length > 0 && (
                  <div>
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-mute">
                      Objection handling
                    </h4>
                    <ul className="mt-2 space-y-2">
                      {profile.objections.map((objection, i) => (
                        <li key={i} className="rounded-lg border border-line bg-surface-2/40 p-3">
                          <p className="text-[13px] font-medium text-ink">“{objection.objection}”</p>
                          <p className="mt-1 text-[13px] text-ink-soft">{objection.response}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {profile.offer && profile.businessConstraints && (
                  <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                    <div>
                      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-mute">Offer</h4>
                      <dl className="mt-2 space-y-1.5 text-[13px]">
                        <div className="flex justify-between gap-3">
                          <dt className="text-ink-mute">Pilot</dt>
                          <dd className="text-ink">
                            {priceLabel(profile.offer.pilotPrice, profile.offer.currency)}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-ink-mute">Monthly</dt>
                          <dd className="text-ink">
                            {priceLabel(profile.offer.monthlyPrice, profile.offer.currency)}
                          </dd>
                        </div>
                        <div className="pt-1 text-ink-soft">{profile.offer.scope}</div>
                      </dl>
                      <div className="mt-3">
                        <BulletList title="Deliverables" items={profile.offer.deliverables} />
                      </div>
                      {profile.offer.terms && (
                        <p className="mt-2 text-[12px] text-ink-mute">{profile.offer.terms}</p>
                      )}
                    </div>
                    <div>
                      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-mute">
                        Business constraints
                      </h4>
                      <dl className="mt-2 space-y-1.5 text-[13px]">
                        <div className="flex justify-between gap-3">
                          <dt className="text-ink-mute">Authorized prices</dt>
                          <dd className="text-ink">
                            {profile.businessConstraints.authorizedPrices.join(", ")}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-ink-mute">Discounts allowed</dt>
                          <dd className="text-ink">
                            {profile.businessConstraints.disallowDiscounts ? "No" : "Yes"}
                          </dd>
                        </div>
                      </dl>
                      <div className="mt-3 space-y-3">
                        <BulletList
                          title="Prohibited claims"
                          items={profile.businessConstraints.prohibitedClaims}
                        />
                        <BulletList
                          title="Prohibited topics"
                          items={profile.businessConstraints.prohibitedTopics}
                        />
                      </div>
                    </div>
                  </div>
                )}

              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
