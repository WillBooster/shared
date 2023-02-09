import type React from 'react';

const css = `
@media print {
  .wb-shared-version {
    display: none;
  }
}`;

export const VersionOverlay: React.FC = () => (
  <>
    <style type="text/css">{css}</style>
    <div
      className="wb-shared-version"
      style={{
        bottom: 4,
        left: 4,
        opacity: 0.5,
        pointerEvents: 'none',
        position: 'fixed',
        userSelect: 'none',
        fontSize: '0.75rem',
      }}
    >
      {process.env.NEXT_PUBLIC_WB_VERSION || process.env.WB_VERSION || 'dev'} on{' '}
      {process.env.NEXT_PUBLIC_WB_ENV || process.env.WB_ENV || 'local'}
    </div>
  </>
);
