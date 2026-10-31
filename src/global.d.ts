import type { SkeletonElfApi } from '@shared/ipc';

declare global {
  interface Window {
    skeletonElf: SkeletonElfApi;
  }
}

export {};
