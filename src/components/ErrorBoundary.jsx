import { Component } from 'react';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ErrorBoundary');

export class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, errorInfo) {
        log.error('组件错误:', error?.message || error);
        log.error('错误堆栈:', errorInfo?.componentStack || '');
    }

    handleReset = () => {
        this.setState({ hasError: false, error: null, errorInfo: null });
    };

    render() {
        if (this.state.hasError) {
            const { fallback, FallbackComponent, onReset } = this.props;

            if (FallbackComponent) {
                return (
                    <FallbackComponent
                        error={this.state.error}
                        resetErrorBoundary={onReset || this.handleReset}
                    />
                );
            }

            if (fallback) {
                return fallback;
            }

            return (
                <div className="error-boundary" style={{
                    padding: '24px',
                    textAlign: 'center',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: '200px',
                    margin: '12px',
                    borderRadius: '18px',
                    background: 'rgba(255, 255, 255, 0.08)',
                    backdropFilter: 'blur(18px) saturate(150%)',
                    WebkitBackdropFilter: 'blur(18px) saturate(150%)',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                }}>
                    <h2 style={{ margin: '0 0 12px', fontSize: '18px' }}>出了点问题</h2>
                    <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                        {this.state.error?.message || '页面加载失败'}
                    </p>
                    <button
                        type="button"
                        onClick={onReset || this.handleReset}
                        style={{
                            padding: '8px 20px',
                            borderRadius: '8px',
                            border: '1px solid rgba(255, 255, 255, 0.16)',
                            background: 'rgba(255, 255, 255, 0.1)',
                            backdropFilter: 'blur(12px) saturate(150%)',
                            WebkitBackdropFilter: 'blur(12px) saturate(150%)',
                            color: 'var(--text-primary)',
                            fontSize: '14px',
                            cursor: 'pointer',
                        }}
                    >
                        重试
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
