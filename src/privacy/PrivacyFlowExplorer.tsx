import { useId, useState } from 'react';
import { disclosureLabels, getPrivacyFlow, privacyFlows, privacyViews } from './flows';
import type { PrivacyFlowId } from './flows';
import './privacy.css';

export interface PrivacyFlowExplorerProps {
  initialFlow?: PrivacyFlowId;
}

/** Explanatory UI only: no workspace access, networking, storage or capability activation. */
export function PrivacyFlowExplorer({ initialFlow = 'local' }: PrivacyFlowExplorerProps) {
  const id = useId();
  const [flowId, setFlowId] = useState<PrivacyFlowId>(initialFlow);
  const [step, setStep] = useState(0);
  const flow = getPrivacyFlow(flowId);
  const implemented = flow.availability === 'implemented';
  const current = flow.steps[step]!;
  function selectFlow(next: PrivacyFlowId) {
    setFlowId(next);
    setStep(0);
  }

  return <section className="privacy-explorer" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Privacy-flow explorer</h2>
    <p>This is an explanation, not a traffic monitor or proof that traffic is blocked. Exploring does not start sharing, connect to a service, download models or change permissions.</p>
    <fieldset>
      <legend>Privacy view</legend>
      {privacyViews.map(view => <label key={view.id}>
        <input type="radio" name={`${id}-view`} value={view.id} checked={flow.view === view.id}
          onChange={() => selectFlow(privacyFlows.find(item => item.view === view.id)!.id)} />
        {view.label}
      </label>)}
    </fieldset>
    <label htmlFor={`${id}-flow`}>Flow to explore</label>
    <select id={`${id}-flow`} value={flowId} onChange={event => selectFlow(event.currentTarget.value as PrivacyFlowId)}>
      {privacyFlows.filter(item => item.view === flow.view).map(item =>
        <option key={item.id} value={item.id}>{item.title} — {item.availability === 'implemented' ? 'Implemented' : 'Not yet available'}</option>)}
    </select>
    <h3>{flow.title}</h3>
    <p><strong>{implemented ? 'Implemented — requires explicit action and supported configuration' : 'Not yet available — planned design only'}</strong></p>
    <p>{flow.prerequisite}</p>
    <p>{flow.summary}</p>
    <ul aria-label={implemented ? 'Disclosure types' : 'Planned disclosure types, not current transfers'}>
      {flow.disclosures.map(disclosure => <li key={disclosure}>{!implemented && 'Planned: '}{disclosureLabels[disclosure]}</li>)}
    </ul>
    <div className="privacy-step" role="status" aria-live="polite" aria-atomic="true">
      <h4>{implemented ? 'Flow' : 'Planned flow'} step {step + 1} of {flow.steps.length}: {current.boundary}</h4>
      <p>{current.bytes}</p>
      <p><strong>Keys / encryption: </strong>{current.protection}</p>
      <p><strong>Still visible: </strong>{current.visible}</p>
    </div>
    <div className="privacy-controls" role="group" aria-label="Step through explanation">
      <button type="button" disabled={step === 0} onClick={() => setStep(value => Math.max(0, value - 1))}>Previous step</button>
      <button type="button" disabled={step === flow.steps.length - 1}
        onClick={() => setStep(value => Math.min(flow.steps.length - 1, value + 1))}>Next step</button>
    </div>
    <p><strong>Limits: </strong>{flow.caveat}</p>
    <details>
      <summary>Complete text/table equivalent</summary>
      <div className="privacy-table-scroll" role="region" aria-label="Complete flow table" tabIndex={0}>
        <table>
          <caption>{flow.title}: {implemented ? 'implemented data path' : 'planned only, not runtime behavior'}</caption>
          <thead><tr><th scope="col">Step / boundary</th><th scope="col">Bytes</th><th scope="col">Keys / encryption</th><th scope="col">Still visible</th></tr></thead>
          <tbody>{flow.steps.map((item, index) => <tr key={item.boundary} aria-current={index === step ? 'step' : undefined}>
            <th scope="row">{index + 1}. {item.boundary}</th><td>{item.bytes}</td><td>{item.protection}</td><td>{item.visible}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
    <p>The default CSP permits same-origin, built-in BYOK APIs and loopback companion ports 47321/47322. Extra S3, custom AI and model origins require deployment configuration. Permissions do not initiate requests. CSP is not a complete exfiltration defense and does not universally govern WebRTC.</p>
    <nav aria-label="Privacy documentation">
      <a href="https://github.com/mattjunior039/annotator/blob/main/docs/privacy.md">Privacy contract and network verification instructions</a>
      {' · '}<a href="https://github.com/mattjunior039/annotator/blob/main/docs/verification.md">Verification coverage and limits</a>
    </nav>
  </section>;
}
