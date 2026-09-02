declare module '*.mjs?url' {
  const src: string;
  export default src;
}
declare module '*?worker' {
  class WorkerCtor extends Worker {
    constructor();
  }
  export default WorkerCtor;
}
