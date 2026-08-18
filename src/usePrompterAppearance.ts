import { useEffect, useState } from 'react';
import {
  appearanceStorage,
  loadPrompterAppearance,
  nudgePrompterFontSize,
  nudgePrompterLabelFontSize,
  savePrompterAppearance,
  subscribePrompterAppearance,
  type PrompterAppearance,
} from './prompter-appearance';

export function usePrompterAppearance() {
  const [appearance, setAppearance] = useState<PrompterAppearance>(() => (
    loadPrompterAppearance(appearanceStorage())
  ));
  useEffect(() => {
    const storage = appearanceStorage();
    setAppearance(loadPrompterAppearance(storage));
    return subscribePrompterAppearance(setAppearance, storage);
  }, []);
  function commitAppearance(next: PrompterAppearance) {
    setAppearance(savePrompterAppearance(next, appearanceStorage()));
  }
  function nudgeFontSize(delta: number) {
    commitAppearance({
      ...appearance,
      fontSize: nudgePrompterFontSize(appearance.fontSize, delta),
    });
  }
  function nudgeLabelFontSize(delta: number) {
    commitAppearance({
      ...appearance,
      labelFontSize: nudgePrompterLabelFontSize(appearance.labelFontSize, delta),
    });
  }
  return { appearance, commitAppearance, nudgeFontSize, nudgeLabelFontSize };
}
