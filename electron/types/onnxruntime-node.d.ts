/**
 * onnxruntime-node 的 package.json 指向 dist/index.d.ts，但该文件并未随包发布，
 * 所以这里手写一份最小可用声明（只覆盖我们实际用到的 API）。
 */
declare module 'onnxruntime-node' {
  export type TensorDataType = 'float32' | 'float64' | 'int32' | 'int64' | 'uint8' | 'bool';
  export type TensorData = Float32Array | Float64Array | Int32Array | BigInt64Array | Uint8Array | readonly number[];

  export interface Tensor {
    readonly data: TensorData;
    readonly dims: readonly number[];
    readonly type: string;
  }

  export const Tensor: {
    new (type: TensorDataType, data: TensorData, dims: readonly number[]): Tensor;
  };

  export interface InferenceSession {
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
    release(): Promise<void>;
  }

  export const InferenceSession: {
    create(
      modelPath: string,
      options?: {
        executionProviders?: string[];
        graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all';
        intraOpNumThreads?: number;
        interOpNumThreads?: number;
      },
    ): Promise<InferenceSession>;
  };
}
