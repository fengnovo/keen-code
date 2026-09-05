import * as readline from 'node:readline';

/** 在终端显示请求或工具执行状态 */
export class LoadingIndicator {
  private timer?: NodeJS.Timeout;
  private active = false;
  private frame = 0;
  private message = '';

  start(message: string): void {
    this.stop();
    this.active = true;
    this.message = message;
    this.frame = 0;

    if (!process.stdout.isTTY) {
      process.stdout.write(`[${message}...]\n`);
      return;
    }

    this.render();
    this.timer = setInterval(() => this.render(), 120);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    if (process.stdout.isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
  }

  private render(): void {
    const frames = ['|', '/', '-', '\\'];
    process.stdout.write(
      `\r${frames[this.frame++ % frames.length]} ${this.message}...`,
    );
  }
}
