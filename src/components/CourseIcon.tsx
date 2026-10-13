import {
  Atom,
  BarChart3,
  Binary,
  BookOpen,
  Brain,
  Calculator,
  Camera,
  Code2,
  Cpu,
  Database,
  Eye,
  FlaskConical,
  Globe,
  GraduationCap,
  Layers,
  Network,
  PenLine,
  ScanLine,
  Shield,
  Sigma,
  type LucideIcon,
} from 'lucide-react';
import { cn, courseVars } from '../lib/util.ts';

export const ICONS: Record<string, LucideIcon> = {
  'book-open': BookOpen,
  'graduation-cap': GraduationCap,
  brain: Brain,
  cpu: Cpu,
  camera: Camera,
  eye: Eye,
  scan: ScanLine,
  sigma: Sigma,
  calculator: Calculator,
  network: Network,
  database: Database,
  code: Code2,
  binary: Binary,
  flask: FlaskConical,
  atom: Atom,
  globe: Globe,
  layers: Layers,
  chart: BarChart3,
  shield: Shield,
  pen: PenLine,
};

export function CourseIcon({ icon, color, size = 'md', className }: { icon: string; color: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const Icon = ICONS[icon] ?? BookOpen;
  const box = { sm: 'size-7 rounded-lg', md: 'size-10 rounded-xl', lg: 'size-14 rounded-xl' }[size];
  const ic = { sm: 'size-4', md: 'size-5', lg: 'size-7' }[size];
  return (
    <span
      style={courseVars(color)}
      className={cn(
        'inline-flex shrink-0 items-center justify-center bg-[color-mix(in_srgb,var(--course)_15%,var(--surface))] text-[color-mix(in_srgb,var(--course)_80%,var(--text))]',
        box,
        className,
      )}
      aria-hidden
    >
      <Icon className={ic} />
    </span>
  );
}
