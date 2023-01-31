import type React from 'react';

export const VersionOverlay: React.FC = () => (
  <div
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
    {process.env.NEXT_PUBLIC_VERSION || process.env.VERSION || 'dev'} on{' '}
    {process.env.NEXT_PUBLIC_ENVIRONMENT || process.env.ENVIRONMENT || 'local'}
  </div>
);
