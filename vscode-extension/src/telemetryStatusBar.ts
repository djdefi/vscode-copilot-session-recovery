import * as vscode from 'vscode';
import { SessionTelemetry, LiveSessionMetrics } from './sessionTelemetry';

export class TelemetryStatusBar implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;
    private detailsStatusBar: vscode.StatusBarItem;
    private telemetry: SessionTelemetry;
    private updateInterval: NodeJS.Timeout | null = null;
    private currentMetrics: LiveSessionMetrics | null = null;

    constructor(private context: vscode.ExtensionContext) {
        this.telemetry = new SessionTelemetry();
        
        // Main status bar item - Context usage
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'copilot-recovery.showTelemetryPanel';
        this.statusBarItem.name = 'Copilot Session Telemetry';

        // Secondary status bar for quick actions
        this.detailsStatusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            99
        );
        this.detailsStatusBar.command = 'copilot-recovery.showDashboard';
        this.detailsStatusBar.name = 'Copilot Session Actions';

        // Start auto-refresh
        this.startAutoRefresh();
        this.updateStatusBar();
    }

    private startAutoRefresh() {
        // Update every 10 seconds
        this.updateInterval = setInterval(() => {
            this.updateStatusBar();
        }, 10000);
    }

    async updateStatusBar() {
        try {
            // Get current workspace folder
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.name;
            
            // Get metrics for active session
            this.currentMetrics = await this.telemetry.getActiveSessionMetrics(workspaceFolder);
            
            if (this.currentMetrics) {
                // Main status: Context usage
                const ctx = this.currentMetrics.tokens;
                const icon = ctx.contextUtilization > 80 ? '$(warning)' : 
                            ctx.contextUtilization > 60 ? '$(info)' : '$(symbol-class)';
                
                const contextK = Math.round(ctx.totalTokens / 1000);
                const limitK = Math.round(ctx.contextLimit / 1000);
                
                this.statusBarItem.text = `${icon} ${contextK}K/${limitK}K`;
                this.statusBarItem.tooltip = this.createTooltip(this.currentMetrics);
                this.statusBarItem.backgroundColor = ctx.contextUtilization > 80 
                    ? new vscode.ThemeColor('statusBarItem.warningBackground') 
                    : undefined;
                this.statusBarItem.show();

                // Details status
                const pendingText = this.currentMetrics.pendingEditsCount > 0 
                    ? `$(edit) ${this.currentMetrics.pendingEditsCount}` : '';
                const msgText = `$(comment) ${this.currentMetrics.requests.totalRequests}`;
                const healthIcon = this.currentMetrics.health.status === 'healthy' ? '$(pass)' :
                                   this.currentMetrics.health.status === 'warning' ? '$(warning)' : '$(error)';
                
                this.detailsStatusBar.text = `${healthIcon} ${msgText} ${pendingText}`.trim();
                this.detailsStatusBar.tooltip = new vscode.MarkdownString([
                    `**Session**: ${this.currentMetrics.title}`,
                    `**Health**: ${this.currentMetrics.health.score}/100`,
                    `**Messages**: ${this.currentMetrics.requests.totalRequests}`,
                    `**Pending Edits**: ${this.currentMetrics.pendingEditsCount}`,
                    '',
                    '*Click for dashboard*'
                ].join('\n\n'));
                this.detailsStatusBar.show();
            } else {
                // No active session
                this.statusBarItem.text = '$(symbol-class) No session';
                this.statusBarItem.tooltip = 'No active Copilot session detected';
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.show();
                
                this.detailsStatusBar.hide();
            }
        } catch (error) {
            this.statusBarItem.text = '$(error) Error';
            this.statusBarItem.tooltip = `Error getting session metrics: ${error}`;
            this.statusBarItem.show();
        }
    }

    private createTooltip(metrics: LiveSessionMetrics): vscode.MarkdownString {
        const ctx = metrics.tokens;
        const req = metrics.requests;
        const health = metrics.health;

        // Create a progress bar
        const filled = Math.round(ctx.contextUtilization / 5);
        const empty = 20 - filled;
        const progressBar = '█'.repeat(filled) + '░'.repeat(empty);

        const lines = [
            `### 📊 Copilot Session Telemetry`,
            '',
            `**${metrics.title}** *(${metrics.workspace})*`,
            '',
            `---`,
            '',
            `#### Context Window`,
            `\`${progressBar}\` **${ctx.contextUtilization}%**`,
            ``,
            `| Metric | Value |`,
            `|--------|-------|`,
            `| Tokens Used | ${ctx.totalTokens.toLocaleString()} |`,
            `| Context Limit | ${ctx.contextLimit.toLocaleString()} |`,
            `| Messages | ${ctx.messageCount} |`,
            `| Avg/Message | ${ctx.avgTokensPerMessage} |`,
            `| Last Response | ${ctx.lastResponseTokens} |`,
            '',
            `#### Requests`,
            `| Metric | Value |`,
            `|--------|-------|`,
            `| Total | ${req.totalRequests} |`,
            `| Successful | ${req.successfulRequests} |`,
            `| Failed | ${req.failedRequests} |`,
            `| Last Hour | ${req.requestsLastHour} |`,
            '',
            `#### Health Score: ${health.score}/100`,
            health.status === 'healthy' ? '✅ Healthy' : 
            health.status === 'warning' ? '⚠️ Warning' : '❌ Critical',
        ];

        if (health.warnings.length > 0) {
            lines.push('', '**Warnings:**');
            health.warnings.forEach(w => lines.push(`- ${w}`));
        }

        if (health.recommendations.length > 0) {
            lines.push('', '**Recommendations:**');
            health.recommendations.forEach(r => lines.push(`- ${r}`));
        }

        lines.push('', '---', '*Click for detailed telemetry panel*');

        const md = new vscode.MarkdownString(lines.join('\n'));
        md.supportHtml = true;
        md.isTrusted = true;
        return md;
    }

    getCurrentMetrics(): LiveSessionMetrics | null {
        return this.currentMetrics;
    }

    forceRefresh() {
        this.updateStatusBar();
    }

    dispose() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        this.statusBarItem.dispose();
        this.detailsStatusBar.dispose();
    }
}
