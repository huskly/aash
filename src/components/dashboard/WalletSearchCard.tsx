import { AlertTriangle, RefreshCw, Wallet } from 'lucide-react';
import { type FormEvent } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Input } from '../ui/input';

export function WalletSearchCard({
  error,
  isLoading,
  wallet,
  onRefresh,
  onSubmit,
  onWalletChange,
}: {
  error: string;
  isLoading: boolean;
  wallet: string;
  onRefresh: () => void | Promise<void>;
  onSubmit: (event: FormEvent) => void | Promise<void>;
  onWalletChange: (wallet: string) => void;
}) {
  return (
    <Card className="mt-6">
      <CardContent className="pt-6">
        <form
          className="flex flex-wrap items-end gap-3 max-[980px]:items-stretch"
          onSubmit={onSubmit}
        >
          <label
            className="grid min-w-0 gap-1.5 text-sm max-[980px]:w-full max-[980px]:max-w-full"
            htmlFor="wallet"
          >
            <span className="text-muted-foreground">Wallet address</span>
            <Input
              className="max-[980px]:max-w-full"
              id="wallet"
              type="text"
              value={wallet}
              onChange={(event) => onWalletChange(event.target.value)}
              placeholder="0x..."
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <Button
            className="max-[980px]:w-full max-[980px]:max-w-full"
            type="submit"
            disabled={isLoading}
          >
            {isLoading ? <RefreshCw size={16} className="animate-spin" /> : <Wallet size={16} />}
            {isLoading ? 'Fetching positions...' : 'Fetch positions'}
          </Button>
          <Button
            className="max-[980px]:w-full max-[980px]:max-w-full"
            type="button"
            variant="secondary"
            onClick={onRefresh}
            disabled={isLoading}
          >
            <RefreshCw size={16} className={isLoading ? 'animate-spin' : undefined} />
            Refresh
          </Button>
        </form>

        {error ? (
          <p className="mt-3 inline-flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle size={16} />
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
