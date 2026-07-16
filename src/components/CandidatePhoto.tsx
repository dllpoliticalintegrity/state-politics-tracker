import { useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { User } from 'lucide-react';

interface CandidatePhotoProps {
  state: string;
  slug: string | null;
  name: string;
  fallbackPhotoUrl?: string | null;
  className?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  borderClassName?: string;
}

const sizeClasses = {
  xs: 'w-8 h-8',
  sm: 'w-10 h-10',
  md: 'w-12 h-12',
  lg: 'w-24 h-24',
};

const getInitials = (name: string) =>
  name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);

const SUPABASE_URL = 'https://qjsesvdduoriofiodumm.supabase.co';

export function CandidatePhoto({
  state,
  slug,
  name,
  fallbackPhotoUrl,
  className,
  size = 'md',
  borderClassName,
}: CandidatePhotoProps) {
  const [phase, setPhase] = useState<'storage' | 'fallback' | 'error'>('storage');

  const storageUrl = state && slug
    ? `${SUPABASE_URL}/storage/v1/object/public/candidate-photos/${state}/${slug}.jpg`
    : null;

  const currentUrl =
    phase === 'storage' && storageUrl ? storageUrl
    : phase === 'fallback' && fallbackPhotoUrl ? fallbackPhotoUrl
    : null;

  const handleError = () => {
    if (phase === 'storage' && fallbackPhotoUrl) {
      setPhase('fallback');
    } else {
      setPhase('error');
    }
  };

  if (!currentUrl || phase === 'error') {
    return (
      <div className={cn(sizeClasses[size], 'rounded-full bg-muted flex items-center justify-center', borderClassName, className)}>
        <User className="w-1/2 h-1/2 text-muted-foreground" />
      </div>
    );
  }

  return (
    <img
      src={currentUrl}
      alt={name}
      className={cn(sizeClasses[size], 'rounded-full object-cover', borderClassName, className)}
      onError={handleError}
      loading="lazy"
    />
  );
}
