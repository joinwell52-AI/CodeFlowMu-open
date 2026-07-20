# -*- coding: utf-8 -*-
from pathlib import Path

p = Path("D:/codeflowmu/codeflowmu-desktop/panel/index.html")
text = p.read_text(encoding="utf-8")

old_start = """    <div id="st-git-backup-wrap">
    <div class="dash-section" style="margin-top:4px">
      <div class="dash-section-title" data-i18n="team.gitBackup">🗃 Git 备份</div>
    <div class="tcc-card git-backup-card" id="tc-git" style="margin-top:8px;border:none;background:transparent;padding:0">
      <div class="tc-git-row">"""

new_start = """    <div class="dash-section git-backup-section">
      <div class="dash-section-title" data-i18n="team.gitBackup">🗃 Git 备份</div>
      <div class="tcc-card" id="tc-git">
      <div class="tc-git-row">"""

old_end = """        <button class="hbtn" style="font-size:14px" id="git-push-now-btn" onclick="pushGitNow(this)" data-i18n="team.pushNow">▶ 立即推送</button>
      </div>
      <div style="font-size:14px;color:var(--text3);margin-top:8px" id="tc-git-last-backup"></div>
      <!-- Legacy hidden inputs preserved for saveGitBackupSettings compat -->
    </div>
    </div>
    </div>
  </div>
  <!-- Export Tab -->"""

new_end = """        <button class="hbtn" style="font-size:14px" id="git-push-now-btn" onclick="pushGitNow(this)" data-i18n="team.pushNow">▶ 立即推送</button>
        <button class="hbtn" style="font-size:14px" onclick="saveGitBackupSettings()" data-i18n="st.git.saveBackup">保存配置</button>
      </div>
      <div style="font-size:14px;color:var(--text3);margin-top:8px" id="tc-git-last-backup"></div>
      </div>
    </div>
  </div>
  <!-- Export Tab -->"""

if old_start not in text:
    raise SystemExit("old_start not found")
text = text.replace(old_start, new_start, 1)
if old_end not in text:
    raise SystemExit("old_end not found")
text = text.replace(old_end, new_end, 1)

if "'st.git.saveBackup'" not in text:
    text = text.replace(
        "'team.gitBackupMovedHint':",
        "'st.git.saveBackup':'保存配置',\n    'team.gitBackupMovedHint':",
        1,
    )
    text = text.replace(
        "'team.gitBackupMovedHint':'Git backup moved to",
        "'st.git.saveBackup':'Save settings',\n    'team.gitBackupMovedHint':'Git backup moved to",
        1,
    )

p.write_text(text, encoding="utf-8")
print("fixed", p)
