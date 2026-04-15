import type React from 'react';

const css = `
@media print {
  .wb-shared-version {
    display: none;
  }
}`;

const overlayStyle: React.CSSProperties = {
  bottom: 4,
  fontSize: '0.75rem',
  left: 4,
  opacity: 0.5,
  pointerEvents: 'none',
  position: 'fixed',
  userSelect: 'none',
};

export const VersionOverlay: React.FC = () => (
  <>
    <style type="text/css">{css}</style>
    <div className="wb-shared-version" style={overlayStyle}>
      {process.env.NEXT_PUBLIC_WB_VERSION || process.env.WB_VERSION || 'dev'} on{' '}
      {process.env.NEXT_PUBLIC_WB_ENV || process.env.WB_ENV || 'local'}
    </div>
  </>
);
