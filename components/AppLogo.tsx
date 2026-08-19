import React from 'react';

interface AppLogoProps {
  className?: string;
}

/**
 * App logo — renders the app icon bitmap (public/icons/variants/original.png,
 * copied to dist/icons/variants/original.png by Vite). The source icon is the
 * full-bleed app icon, so no extra rounding is applied here.
 */
export const AppLogo: React.FC<AppLogoProps> = ({ className }) => (
  <img
    src="/icons/variants/original.png"
    alt="Intelligent Terminal"
    className={className}
    draggable={false}
  />
);

export default AppLogo;
