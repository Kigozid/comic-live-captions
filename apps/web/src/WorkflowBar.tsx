import type { ReactNode } from 'react';
import type {
  WorkflowStepId,
  WorkflowStepStatus,
} from './workflow-steps.js';

export type { WorkflowStepId, WorkflowStepStatus };

export interface WorkflowBarProps {
  readonly steps: readonly WorkflowStepStatus[];
  readonly activeStep?: WorkflowStepId | null;
  readonly onStepSelect?: (id: WorkflowStepId) => void;
  readonly onProduceDraft: () => void;
  readonly produceDisabled?: boolean;
  readonly produceBusy?: boolean;
  readonly produceLabel?: string;
  readonly children?: ReactNode;
}

/**
 * Major draft-first workflow strip. Always visible above the canvas so the
 * primary path (import → audio → clean → boxes → draft) stays obvious while
 * secondary tools live in tool-drawer pull-downs.
 */
export function WorkflowBar({
  steps,
  activeStep,
  onStepSelect,
  onProduceDraft,
  produceDisabled = false,
  produceBusy = false,
  produceLabel = 'Produce draft',
  children,
}: WorkflowBarProps) {
  return (
    <div className="workflow-bar" role="navigation" aria-label="Major workflow">
      <ol className="workflow-steps">
        {steps.map((step, index) => {
          const isActive = activeStep === step.id;
          return (
            <li key={step.id} className="workflow-step-li">
              <button
                type="button"
                className={[
                  'workflow-step',
                  step.done ? 'is-done' : '',
                  isActive ? 'is-active' : '',
                  step.busy ? 'is-busy' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                disabled={step.disabled && !step.done}
                title={step.hint}
                onClick={() => onStepSelect?.(step.id)}
              >
                <span className="workflow-step-index" aria-hidden="true">
                  {step.done ? '✓' : index + 1}
                </span>
                <span className="workflow-step-label">{step.label}</span>
              </button>
              {index < steps.length - 1 ? (
                <span className="workflow-step-arrow" aria-hidden="true">
                  ›
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="workflow-actions">
        {children}
        <button
          type="button"
          className="ui-btn primary workflow-draft-btn"
          disabled={produceDisabled || produceBusy}
          onClick={onProduceDraft}
          title="Clean if needed, map dialogue into boxes, export draft MP4"
        >
          {produceBusy ? 'Working…' : produceLabel}
        </button>
      </div>
    </div>
  );
}
