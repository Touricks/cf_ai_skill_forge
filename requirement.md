We plan to fast track review of candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components:
LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
User input via chat or voice (recommend using Pages or Realtime), Memory or state

For additional documentation, see https://developers.cloudflare.com/agents/

IDEA
核心功能（MVP）：
输入: 一段对话记录 + 用户标注的关键决策点
输出: SKILL.md 草稿 + 识别出的参数化部分

不做（V2）：
- 自动选择对话中的关键部分（先让用户手动标注）
- 多 skill 编排