import type { NextConfig } from 'next';

const config: NextConfig = {
  // This app lives inside the library's repository, which has a lockfile of its own.
  turbopack: { root: import.meta.dirname }
};

export default config;
