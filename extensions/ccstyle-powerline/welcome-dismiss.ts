export interface WelcomeDismissScheduler<Context> {
  schedule(ctx: Context): void;
  cancel(): void;
}

interface WelcomeDismissSchedulerOptions<Context> {
  dismiss(ctx: Context): void;
  getGeneration(): number;
  isEnabled(): boolean;
}

export function createWelcomeDismissScheduler<Context>(
  options: WelcomeDismissSchedulerOptions<Context>,
): WelcomeDismissScheduler<Context> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    schedule(ctx) {
      if (timer) return;

      const generation = options.getGeneration();
      timer = setTimeout(() => {
        timer = null;
        if (!options.isEnabled() || generation !== options.getGeneration()) return;
        options.dismiss(ctx);
      }, 0);
    },
    cancel() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    },
  };
}
