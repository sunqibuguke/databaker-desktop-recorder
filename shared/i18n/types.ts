import type zhCN from './catalogs/zh-CN.ts';

type DeepStringify<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringify<T[K]>;
};

export type MessageTree = DeepStringify<typeof zhCN>;
