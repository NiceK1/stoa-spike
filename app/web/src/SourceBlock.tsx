/** The source of an answer, as the server's `Answer.source` describes it (server/src/types.ts). */
import type { Tier } from "./modes";

/** `label` is a model's display name; `name` stays its id. Scripts, and answers from an older server, have none. */
export interface Contributor { name: string; label?: string; tier: Tier; did?: string }
export interface AnswerSource {
  understoodBy: Contributor & { by: "model" | "keyword-parser" | "stated-type" | "nobody"; reading?: string; why?: string; helper?: Contributor };
  calculatedBy: Contributor[];
  needed?: string;
  from: { file: string; used: string };
}

const TIERS: Record<Tier, string> = {
  script: "Blueline script",
  "own-model": "Blueline model",
  "self-hosted-model": "self-hosted model",
  "external-model": "outside model",
};

export function TierTag({ tier }: { tier: Tier }) {
  return <span className={`tier ${tier}`}>{TIERS[tier] ?? tier}</span>;
}

/** An answer's note without the reason for having no value, which the Source block prints as "Not calculated". */
export function noteBeside(note: string | undefined, source: AnswerSource | undefined): string | undefined {
  const said = source?.needed;
  return note && said && note.startsWith(said) ? note.slice(said.length).trim() || undefined : note;
}

/** `untagged` is for a line that names no script or model: a stated answer type, a question nobody read. */
function By({ who, untagged, children }: { who: Contributor; untagged?: boolean; children?: React.ReactNode }) {
  return (
    <div className="by">
      {!untagged && <TierTag tier={who.tier} />}
      <b>{who.label ?? who.name}</b>
      {who.label && <> <span className="model-id">{who.name}</span></>}
      {children}
    </div>
  );
}

/** Three lines under an answer: who understood the question, what calculated the value, and from which data. */
export function SourceBlock({ source }: { source: AnswerSource }) {
  const { understoodBy, calculatedBy, needed, from } = source;
  return (
    <dl className="source" aria-label="Source of the answer">
      <dt>Understood by</dt>
      <dd>
        <By who={understoodBy} untagged={understoodBy.by === "stated-type" || understoodBy.by === "nobody"}>
          {understoodBy.reading ? <> as “{understoodBy.reading}”</> : understoodBy.why ? <> ({understoodBy.why})</> : null}
        </By>
        {understoodBy.helper && <By who={understoodBy.helper}>{understoodBy.helper.did && <>: {understoodBy.helper.did}</>}</By>}
      </dd>
      <dt>Calculated by</dt>
      <dd>
        {calculatedBy.map((each, i) => <By key={i} who={each}>{each.did && <>: {each.did}</>}</By>)}
        {(needed || calculatedBy.length === 0) && <div className="by">Not calculated{needed ? `: ${needed}` : ""}</div>}
      </dd>
      <dt>From</dt>
      <dd>
        <b>{from.file}</b>
        {from.used !== "nothing" && <>: {from.used}</>}
      </dd>
    </dl>
  );
}
