/**
 * Background Service - Stub (artık sunucuda çalışıyor, telefonda gerek yok)
 */

class BackgroundServiceManager {
  isRunning = false;
  async start() { this.isRunning = true; }
  async stop() { this.isRunning = false; }
}

const backgroundServiceManager = new BackgroundServiceManager();
export default backgroundServiceManager;
